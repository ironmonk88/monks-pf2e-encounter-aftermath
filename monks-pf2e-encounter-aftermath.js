import { registerSettings } from "./settings.js";

export let debug = (...args) => {
    if (debugEnabled > 1) console.log("DEBUG: monks-pf2e-encounter-aftermath | ", ...args);
};
export let log = (...args) => console.log("monks-pf2e-encounter-aftermath | ", ...args);
export let warn = (...args) => {
    if (debugEnabled > 0) console.warn("monks-pf2e-encounter-aftermath | ", ...args);
};
export let error = (...args) => console.error("monks-pf2e-encounter-aftermath | ", ...args);
export let i18n = (key, args) => {
    if (args) {
        return game.i18n.format(key, args);
    }
    return game.i18n.localize(key);
};

export let setting = key => {
    return game.settings.get("monks-pf2e-encounter-aftermath", key);
};

export let patchFunc = (prop, func, type = "WRAPPER") => {
    if (game.modules.get("lib-wrapper")?.active) {
        libWrapper.register("monks-pf2e-encounter-aftermath", prop, func, type);
    } else {
        const oldFunc = eval(prop);
        eval(`${prop} = function (event) {
            return func.call(this, oldFunc.bind(this), ...arguments);
        }`);
    }
}

export class MonksPF2EEncounterAftermath {
    static app = null;

    static async init() {
        registerSettings();

        try {
            Object.defineProperty(User.prototype, "isTheGM", {
                get: function isTheGM() {
                    return this == (game.users.find(u => u.hasRole("GAMEMASTER") && u.active) || game.users.find(u => u.hasRole("ASSISTANT") && u.active));
                }
            });
        } catch { }

        MonksPF2EEncounterAftermath.SOCKET = "module.monks-pf2e-encounter-aftermath";

        patchFunc("ActorSheet.prototype._renderInner", async function (wrapped, ...args) {
            let inner = await wrapped(...args);

            if (this.constructor.name == "PartySheetPF2e") {
                let [data] = args;

                for (let m of data.members) {
                    let canRun = m.actor.testUserPermission(game.user, "OWNER");
                    let arr = (getProperty(m.actor, "flags.monks-pf2e-encounter-aftermath.activities") || []);
                    m.aftermath = await Promise.all(arr.map(async (b) => {
                        if (b.actionUuid) {
                            let item = await fromUuid(b.actionUuid);
                            if (item) {
                                b.name = item.name;
                                b.img = item.img;
                            }
                        }
                        b.canRun = canRun;
                        b.showRun = b.showRun ?? true;
                        b.remaining = b.interval - b.elapsed;
                        return b;
                    }));
                    m.aftermath = m.aftermath.filter(b => b.name);
                };

                let timeSpent = getProperty(data.actor, "flags.monks-pf2e-encounter-aftermath.timeSpent") || 0;
                let timeRemaining = MonksPF2EEncounterAftermath.getRemainingTime();
                let timeAdvance = MonksPF2EEncounterAftermath.getAdvanceTime();
                let aftermath = data.members.reduce((total, m) => { return total + m.aftermath.filter(a => a.showRun).length; }, 0);

                let advanceMsg = timeAdvance == 0 ? i18n("MonksPF2eEncounterAftermath.HasActivities") : (timeAdvance == null ? i18n("MonksPF2eEncounterAftermath.NoActivities") : i18n("MonksPF2eEncounterAftermath.CanAdvance", {timeAdvance}));

                data.activitySummary = {
                    timeSpent,
                    timeRemaining,
                    timeAdvance,
                    advanceMsg,
                    aftermath
                }

                let template = await renderTemplate("modules/monks-pf2e-encounter-aftermath/templates/party-activities.html", data);
                let activityTab = $("<div>").attr("data-tab", "aftermath").addClass("tab").append(template);

                $('> .sub-nav a[data-tab="exploration"]', inner).after($("<a>").attr("data-tab", "aftermath").text(i18n("MonksPF2eEncounterAftermath.Aftermath")));
                $('> section.container div[data-tab="exploration"]', inner).after(activityTab);
            }

            return inner;
        });
    }

    static emit(action, args = {}) {
        args.action = action;
        args.senderId = game.user.id;
        game.socket.emit(MonksPF2EEncounterAftermath.SOCKET, args, (resp) => {});
    }

    static async onMessage(data) {
        switch (data.action) {
            case 'sendMessage': {
                ui.notifications.info(data.message);
            }
        }
    }

    static getRemainingTime() {
        let party = game.actors.party;
        let maxTime = 0;
        for (let member of party.members) {
            let activities = getProperty(member, "flags.monks-pf2e-encounter-aftermath.activities") || [];
            if (activities.length) {
                for (let activity of activities) {
                    let remaining = activity.interval - activity.elapsed;
                    if (remaining > maxTime)
                        maxTime = remaining;
                }
            }
        }

        return maxTime;
    }

    static getAdvanceTime() {
        let party = game.actors.party;
        let minTime = null;
        for (let member of party.members) {
            let activities = getProperty(member, "flags.monks-pf2e-encounter-aftermath.activities") || [];
            if (activities.length) {
                for (let activity of activities) {
                    let remaining = activity.interval - activity.elapsed;
                    if (minTime == null || remaining < minTime)
                        minTime = remaining;
                }
            }
        }

        return minTime;
    }

    static async elapseTime() {
        // Find the minimum activty time out of all the activities, (total time - elapsed time)
        let party = game.actors.party;
        let minTime = MonksPF2EEncounterAftermath.getAdvanceTime();

        if (minTime <= 0 || minTime == null) {
            let msg = minTime <= 0 ? i18n("MonksPF2eEncounterAftermath.HasActivities") : i18n("MonksPF2eEncounterAftermath.NoActivities");
            ui.notifications.warn(msg);
            return;
        }

        // Advance the time taken by that ammount and set the elapsed time of any remaining activities
        let timeSpent = getProperty(party, "flags.monks-pf2e-encounter-aftermath.timeSpent") || 0;
        timeSpent += minTime;
        await party.setFlag("monks-pf2e-encounter-aftermath", "timeSpent", timeSpent);

        for (let member of party.members) {
            let activities = duplicate(getProperty(member, "flags.monks-pf2e-encounter-aftermath.activities") || []);
            if (activities.length) {
                for (let activity of activities) {
                    activity.elapsed += minTime;
                }
                await member.setFlag("monks-pf2e-encounter-aftermath", "activities", activities);
            }
        }

        let msgSpentTime = i18n("MonksPF2eEncounterAftermath.HasSpentTime", { minTime });
        ui.notifications.info(msgSpentTime);
        MonksPF2EEncounterAftermath.emit("sendMessage", { message: msgSpentTime });
        game.time.advance(minTime * 60);

        //this.render();
    }

    static async runActivity(actor, activity) {
        let remaining = activity.interval - activity.elapsed;
        if (remaining > 0) {
            ui.notifications.info(i18n("MonksPF2eEncounterAftermath.ActivityRemainingTime", {name: activity.name, remaining}));
            return;
        }

        if (activity.actionUuid != null) {
            // Run the associated activity
            let action = await fromUuid(activity.actionUuid);
            if (action) {
                if (action instanceof Macro) {
                    let token = canvas.tokens.placeables.find(t => t.actor?.id == actor.id);
                    if (token)
                        token.control({ releaseOthers: true });
                    action.execute();
                } else if (action instanceof Item) {
                    if (action.type == "spell") {
                        action.spellcasting.cast(action, {
                            slot: Number(NaN),
                            level: Number(NaN)
                        });
                    } else if (action.isOfType("action", "feat")) {
                        if (action.system.selfEffect) {
                            let effect = await fromUuid(action.system.selfEffect.uuid);
                            if (effect.isOfType("effect")) {
                                await actor.createEmbeddedDocuments("Item", [effect.clone().toObject()]);
                            }
                        }
                    }
                }
            }
        }

        // Clear the activity
        let activities = duplicate(getProperty(actor, "flags.monks-pf2e-encounter-aftermath.activities") || []);
        activities = activities.filter(b => b.uuid != activity.uuid);
        await actor.setFlag("monks-pf2e-encounter-aftermath", "activities", activities);

        //this.render();
    }

    static ready() {
        game.socket.on(MonksPF2EEncounterAftermath.SOCKET, MonksPF2EEncounterAftermath.onMessage);
    }
}

Hooks.once('init', MonksPF2EEncounterAftermath.init);
Hooks.once('ready', MonksPF2EEncounterAftermath.ready);

Hooks.on("renderPartySheetPF2e", async (partySheet, html, data) => {
    const content = partySheet.popOut ? html[0].parentElement : html[0];

    $("div[data-tab='aftermath'] .content .member-activity", content).on("dragover", (event) => {
        MonksPF2EEncounterAftermath.droptarget = event.currentTarget.dataset.actorUuid;
    });
    $("div[data-tab='aftermath'] .content a[data-action='clear-activities']", content).on("click", async (event) => {
        let actor = game.actors.party;
        if (actor && actor.testUserPermission(game.user, "OWNER")) {
            await actor.setFlag("monks-pf2e-encounter-aftermath", "timeSpent", 0);
            for (let member of actor.members) {
                await member.setFlag("monks-pf2e-encounter-aftermath", "activities", []);
            }
            //partySheet.render();
            ui.notifications.info(i18n("MonksPF2eEncounterAftermath.ActivitiesCleared"));
        }
    });
    $("div[data-tab='aftermath'] .content button[data-action='advance-time']", content).on("click", MonksPF2EEncounterAftermath.elapseTime.bind(partySheet));
    $("div[data-tab='aftermath'] .content button[data-action='run-action']", content).on("click", async (event) => {
        let actorUuid = event.currentTarget.closest(".member-activity").dataset.actorUuid;
        let activityUuid = event.currentTarget.closest(".activity").dataset.activityUuid;

        let actor = await fromUuid(actorUuid);
        if (actor && actor.testUserPermission(game.user, "OWNER")) {
            let activities = getProperty(actor, "flags.monks-pf2e-encounter-aftermath.activities") || [];
            let activity = activities.find(b => b.uuid == activityUuid);
            if (activity) {
                MonksPF2EEncounterAftermath.runActivity.call(partySheet, actor, activity);
            }
        }
    });
    $("div[data-tab='aftermath'] .content select.time-options", content).on("change", async (event) => {
        let actorUuid = event.currentTarget.closest(".member-activity").dataset.actorUuid;
        let activityUuid = event.currentTarget.closest(".activity").dataset.activityUuid;
        let interval = event.currentTarget.value;

        let actor = await fromUuid(actorUuid);
        if (actor && actor.testUserPermission(game.user, "OWNER")) {
            let activities = duplicate(getProperty(actor, "flags.monks-pf2e-encounter-aftermath.activities") || []);
            let activity = activities.find(b => b.uuid == activityUuid);
            if (activity) {
                activity.interval = parseInt(interval);
                await actor.setFlag("monks-pf2e-encounter-aftermath", "activities", activities);
                //partySheet.render();
            }
        }
    });
    $("div[data-tab='aftermath'] .content a[data-action='clear-activity']", content).on("click", async (event) => {
        let actorUuid = event.currentTarget.closest(".member-activity").dataset.actorUuid;
        let activityUuid = event.currentTarget.closest(".activity").dataset.activityUuid;

        let actor = await fromUuid(actorUuid);
        if (actor && actor.testUserPermission(game.user, "OWNER")) {
            let activities = duplicate(getProperty(actor, "flags.monks-pf2e-encounter-aftermath.activities") || []);
            activities = activities.filter(b => b.uuid != activityUuid);
            await actor.setFlag("monks-pf2e-encounter-aftermath", "activities", activities);
            //partySheet.render();
        }
    });

    if (!partySheet._mpb_context_activity) {
        partySheet._mpb_context_activity = new ContextMenu(content, ".member-activity div.empty", [
            {
                name: i18n("MonksPF2eEncounterAftermath.DoNothing"),
                icon: '<i class="far fa-hourglass"></i>',
                condition: async (elem) => {
                    let actorUuid = elem[0].closest(".member-activity").dataset.actorUuid;
                    let actor = await fromUuid(actorUuid);
                    return (actor && actor.testUserPermission(game.user, "OWNER"));
                },
                callback: async (elem) => {
                    let actorUuid = elem[0].closest(".member-activity").dataset.actorUuid;
                    let actor = await fromUuid(actorUuid);
                    if (actor && actor.testUserPermission(game.user, "OWNER")) {
                        let activities = duplicate(getProperty(actor, "flags.monks-pf2e-encounter-aftermath.activities") || []);
                        if (activities.length == 0) {
                            activities.push({
                                interval: 10,
                                elapsed: 0,
                                uuid: randomID(),
                                showRun: false,
                                name: i18n("MonksPF2eEncounterAftermath.DoNothing"),
                                img: "icons/svg/sleep.svg"
                            });
                            await actor.setFlag("monks-pf2e-encounter-aftermath", "activities", activities);
                        }
                    }
                }
            }
        ]);
    }

    if (!partySheet._mpb_context_stats) {
        partySheet._mpb_context_stats = new ContextMenu(content, ".activities-members .summary", [
            {
                name: i18n("MonksPF2eEncounterAftermath.ClearStats"),
                icon: '<i class="far fa-trash"></i>',
                condition: async () => {
                    return game.user.isGM;
                },
                callback: async (elem) => {
                    let party = game.actors.party;
                    if (party && party.testUserPermission(game.user, "OWNER")) {
                        await party.setFlag("monks-pf2e-encounter-aftermath", "timeSpent", 0);
                        ui.notifications.info(i18n("MonksPF2eEncounterAftermath.StatisticsCleared"));
                    }
                }
            }
        ]);
    }
});

Hooks.on("dropActorSheetData", (object, sheet, data) => {
    if (sheet._tabs[0].active == "aftermath" && (data.type == "Macro" || data.type == "Item" || data.type == "Action")) {
        new Promise(async (resolve, reject) => {
            let actor = await fromUuid(MonksPF2EEncounterAftermath.droptarget);
            if (actor && actor.testUserPermission(game.user, "OWNER")) {
                let activities = duplicate(getProperty(actor, "flags.monks-pf2e-encounter-aftermath.activities") || []);
                activities.push({
                    interval: 10,
                    elapsed: 0,
                    uuid: randomID(),
                    actionUuid: data.uuid
                });
                await actor.setFlag("monks-pf2e-encounter-aftermath", "activities", activities);
                //sheet.render();
            }
        });
        data.type = null;
        return false;
    }
});

Hooks.on("deleteCombat", async (combat) => {
    if (game.user.isTheGM && setting("show-after-combat") && combat.started) {
        // Create a chat card with the time the combat took and a link to the party sheet
        let timeSpent = ((combat.round - 1) * 6 * combat.turns.length) + (combat.turn * 6);
        let timeMsg = `${timeSpent >= 60 ? Math.floor(timeSpent / 60) + "m " : ""}${timeSpent >= 60 ? (timeSpent % 60).toString().padStart(2, "0") : (timeSpent % 60).toString() }s`;
        let chatData = {
            user: game.user.id,
            speaker: ChatMessage.getSpeaker({ actor: game.actors.party }),
            flavor: i18n("MonksPF2eEncounterAftermath.CombatEndFlavor"), //"The battle is over!"
            content: await renderTemplate("modules/monks-pf2e-encounter-aftermath/templates/combat-end.html", {
                timeMsg
            }),
            flags: {
                monks_pf2e_encounter_aftermath: {
                    assigned: false,
                    timeSpent
                }
            }
        }

        await ChatMessage.create(chatData, {});
    }
});

Hooks.on("renderChatMessage", async (message, html, data) => {
    if (message.data.flags?.monks_pf2e_encounter_aftermath != undefined) {
        if (!game.user.isGM)
            html.find(".gm-only").remove();

        html.find("button[data-action='advance-time']").on("click", async (event) => {
            if (!game.user.isGM || message.data.flags?.monks_pf2e_encounter_aftermath.assigned)
                return;

            let timeSpent = message.data.flags?.monks_pf2e_encounter_aftermath.timeSpent || 0;
            game.time.advance(timeSpent);

            let content = $(message.content);
            $("button[data-action='advance-time']", content).remove();
            await message.update({ content: content[0].outerHTML, flags: { "monks-pf2e-encounter-aftermath": { assigned: true } } });
        });

        html.find("button[data-action='join-party-sheet']").on("click", async (event) => {
            let actor = game.actors.party;
            if (actor) {
                let sheet = await actor.sheet;
                let oldRender = sheet._render;
                sheet._render = async function (force = false, options = {}) {
                    let result = await oldRender.call(this, force, options);
                    sheet._tabs[0].activate("aftermath");
                    sheet._render = oldRender;
                    return result;
                };
                sheet.render(true);
            }
        });
    }
});
