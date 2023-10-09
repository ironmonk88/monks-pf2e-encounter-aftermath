import { registerSettings } from "./settings.js";

export let debug = (...args) => {
    if (debugEnabled > 1) console.log("DEBUG: monks-pf2e-breaktime | ", ...args);
};
export let log = (...args) => console.log("monks-pf2e-breaktime | ", ...args);
export let warn = (...args) => {
    if (debugEnabled > 0) console.warn("monks-pf2e-breaktime | ", ...args);
};
export let error = (...args) => console.error("monks-pf2e-breaktime | ", ...args);
export let i18n = key => {
    return game.i18n.localize(key);
};

export let setting = key => {
    return game.settings.get("monks-pf2e-breaktime", key);
};

export let patchFunc = (prop, func, type = "WRAPPER") => {
    if (game.modules.get("lib-wrapper")?.active) {
        libWrapper.register("monks-pf2e-breaktime", prop, func, type);
    } else {
        const oldFunc = eval(prop);
        eval(`${prop} = function (event) {
            return func.call(this, oldFunc.bind(this), ...arguments);
        }`);
    }
}

export class MonksPF2EBreaktimeActivities {
    static app = null;

    static async init() {
        log("initializing");

        MonksPF2EBreaktimeActivities.SOCKET = "module.monks-pf2e-breaktime";

        // init socket
        game.socket.on(MonksPF2EBreaktimeActivities.SOCKET, MonksPF2EBreaktimeActivities.onMessage);

        patchFunc("ActorSheet.prototype._renderInner", async function (wrapped, ...args) {
            let inner = await wrapped(...args);

            if (this.constructor.name == "PartySheetPF2e") {
                let [data] = args;

                for (let m of data.members) {
                    let canRun = m.actor.testUserPermission(game.user, "OWNER");
                    let arr = (getProperty(m.actor, "flags.monks-pf2e-breaktime.breaktime") || []);
                    m.breaktime = await Promise.all(arr.map(async (b) => {
                        let item = await fromUuid(b.uuid);
                        if (item) {
                            b.name = item.name;
                            b.img = item.img;
                        }
                        b.canRun = canRun;
                        b.showRun = b.showRun ?? true;
                        b.remaining = b.interval - b.elapsed;
                        return b;
                    }));
                    m.breaktime = m.breaktime.filter(b => b.name);
                };

                let timeSpent = getProperty(data.actor, "flags.monks-pf2e-breaktime.timeSpent") || 0;
                let timeRemaining = MonksPF2EBreaktimeActivities.getRemainingTime();
                let timeAdvance = MonksPF2EBreaktimeActivities.getAdvanceTime();
                let activities = data.members.reduce((total, m) => { return total + m.breaktime.filter(a => a.showRun).length; }, 0);

                let advanceMsg = timeAdvance == 0 ? `Party has activities that can be performed` : (timeAdvance == null ? `Party has no activities to perform` : `Party can advance ${timeAdvance} minutes`);

                data.activitySummary = {
                    timeSpent,
                    timeRemaining,
                    timeAdvance,
                    advanceMsg,
                    activities
                }

                let template = await renderTemplate("modules/monks-pf2e-breaktime/templates/party-activities.html", data);
                let activityTab = $("<div>").attr("data-tab", "activities").addClass("tab").append(template);

                $('> .sub-nav a[data-tab="exploration"]', inner).after($("<a>").attr("data-tab", "activities").text("Activities"));
                $('> section.container div[data-tab="exploration"]', inner).after(activityTab);
            }

            return inner;
        });
    }

    static async setup() {
    }

    static async ready() {
    }

    static emit(action, args = {}) {
        args.action = action;
        args.senderId = game.user.id;
        game.socket.emit(MonksPF2EBreaktimeActivities.SOCKET, args, (resp) => { });
        MonksPF2EBreaktimeActivities.onMessage(args);
    }

    static onMessage(data) {
        MonksPF2EBreaktimeActivities[data.action].call(MonksPF2EBreaktimeActivities, data);
    }

    static getRemainingTime() {
        let party = game.actors.party;
        let maxTime = 0;
        for (let member of party.members) {
            let breaktime = getProperty(member, "flags.monks-pf2e-breaktime.breaktime") || [];
            if (breaktime.length) {
                for (let activity of breaktime) {
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
            let breaktime = getProperty(member, "flags.monks-pf2e-breaktime.breaktime") || [];
            if (breaktime.length) {
                for (let activity of breaktime) {
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
        let minTime = MonksPF2EBreaktimeActivities.getAdvanceTime();

        if (minTime == 0 || minTime == null) {
            let msg = minTime == 0 ? `Party still has activities that can be performed` : `Party has no activities to perform`;
            ui.notifications.warn(msg);
            return;
        }

        // Advance the time taken by that ammount and set the elapsed time of any remaining activities
        let timeSpent = getProperty(party, "flags.monks-pf2e-breaktime.timeSpent") || 0;
        timeSpent += minTime;
        await party.setFlag("monks-pf2e-breaktime", "timeSpent", timeSpent);

        for (let member of party.members) {
            let breaktime = duplicate(getProperty(member, "flags.monks-pf2e-breaktime.breaktime") || []);
            if (breaktime.length) {
                for (let activity of breaktime) {
                    activity.elapsed += minTime;
                }
                await member.setFlag("monks-pf2e-breaktime", "breaktime", breaktime);
            }
        }

        ui.notifications.info(`Party has spent ${minTime} minutes on activities`);
        game.time.advance(minTime * 60);

        //this.render();
    }

    static async runActivity(actor, activity) {
        let remaining = activity.interval - activity.elapsed;
        if (remaining > 0) {
            ui.notifications.info(`Activity '${activity.name}' has ${remaining} minutes remaining`);
            return;
        }

        // Run the associated activity
        let item = await fromUuid(activity.uuid);
        if (item) {
            if (item instanceof Macro) {
                let token = canvas.tokens.placeables.find(t => t.actor?.id == actor.id);
                if (token)
                    token.control({ releaseOthers: true });
                item.execute();
            } else if (item instanceof Item) {
                if (item.type == "spell") {
                    item.spellcasting.cast(item, {
                        slot: Number(NaN),
                        level: Number(NaN)
                    });
                } else if (item.isOfType("action", "feat")) {
                    if (item.system.selfEffect) {
                        let effect = await fromUuid(item.system.selfEffect.uuid);
                        if (effect.isOfType("effect")){
                            await actor.createEmbeddedDocuments("Item", [effect.clone().toObject()]);
                        }
                    }
                }
            }
        }

        // Clear the activity
        let breaktime = duplicate(getProperty(actor, "flags.monks-pf2e-breaktime.breaktime") || []);
        breaktime = breaktime.filter(b => b.uuid != activity.uuid);
        await actor.setFlag("monks-pf2e-breaktime", "breaktime", breaktime);

        //this.render();
    }
}

Hooks.once('init', MonksPF2EBreaktimeActivities.init);
Hooks.once('setup', MonksPF2EBreaktimeActivities.setup);
Hooks.once('ready', MonksPF2EBreaktimeActivities.ready);

Hooks.on("renderPartySheetPF2e", async (partySheet, html, data) => {
    const content = partySheet.popOut ? html[0].parentElement : html[0];

    $("div[data-tab='activities'] .content .member-activity", content).on("dragover", (event) => {
        MonksPF2EBreaktimeActivities.droptarget = event.currentTarget.dataset.actorUuid;
    });
    $("div[data-tab='activities'] .content a[data-action='clear-activities']", content).on("click", async (event) => {
        let actor = game.actors.party;
        if (actor && actor.testUserPermission(game.user, "OWNER")) {
            await actor.setFlag("monks-pf2e-breaktime", "timeSpent", 0);
            for (let member of actor.members) {
                await member.setFlag("monks-pf2e-breaktime", "breaktime", []);
            }
            //partySheet.render();
            ui.notifications.info("Party breaktime activites has been cleared");
        }
    });
    $("div[data-tab='activities'] .content button[data-action='advance-time']", content).on("click", MonksPF2EBreaktimeActivities.elapseTime.bind(partySheet));
    $("div[data-tab='activities'] .content button[data-action='run-action']", content).on("click", async (event) => {
        let actorUuid = event.currentTarget.closest(".member-activity").dataset.actorUuid;
        let activityUuid = event.currentTarget.closest(".activity").dataset.activityUuid;

        let actor = await fromUuid(actorUuid);
        if (actor && actor.testUserPermission(game.user, "OWNER")) {
            let breaktime = getProperty(actor, "flags.monks-pf2e-breaktime.breaktime") || [];
            let activity = breaktime.find(b => b.uuid == activityUuid);
            if (activity) {
                MonksPF2EBreaktimeActivities.runActivity.call(partySheet, actor, activity);
            }
        }
    });
    $("div[data-tab='activities'] .content select.time-options", content).on("change", async (event) => {
        let actorUuid = event.currentTarget.closest(".member-activity").dataset.actorUuid;
        let activityUuid = event.currentTarget.closest(".activity").dataset.activityUuid;
        let interval = event.currentTarget.value;

        let actor = await fromUuid(actorUuid);
        if (actor && actor.testUserPermission(game.user, "OWNER")) {
            let breaktime = duplicate(getProperty(actor, "flags.monks-pf2e-breaktime.breaktime") || []);
            let activity = breaktime.find(b => b.uuid == activityUuid);
            if (activity) {
                activity.interval = parseInt(interval);
                await actor.setFlag("monks-pf2e-breaktime", "breaktime", breaktime);
                //partySheet.render();
            }
        }
    });
    $("div[data-tab='activities'] .content a[data-action='clear-activity']", content).on("click", async (event) => {
        let actorUuid = event.currentTarget.closest(".member-activity").dataset.actorUuid;
        let activityUuid = event.currentTarget.closest(".activity").dataset.activityUuid;

        let actor = await fromUuid(actorUuid);
        if (actor && actor.testUserPermission(game.user, "OWNER")) {
            let breaktime = duplicate(getProperty(actor, "flags.monks-pf2e-breaktime.breaktime") || []);
            breaktime = breaktime.filter(b => b.uuid != activityUuid);
            await actor.setFlag("monks-pf2e-breaktime", "breaktime", breaktime);
            //partySheet.render();
        }
    });

    if (!partySheet._mpb_context) {
        partySheet._mpb_context = new ContextMenu(content, ".member-activity div.empty", [{
            name: "Do Nothing",
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
                    let breaktime = duplicate(getProperty(actor, "flags.monks-pf2e-breaktime.breaktime") || []);
                    if (breaktime.length == 0) {
                        breaktime.push({
                            interval: 10,
                            elapsed: 0,
                            uuid: randomID(),
                            showRun: false,
                            name: "Do Nothing",
                            img: "icons/svg/sleep.svg"
                        });
                        await actor.setFlag("monks-pf2e-breaktime", "breaktime", breaktime);
                    }
                }
            }
        }]);
    }
});

Hooks.on("dropActorSheetData", (object, sheet, data) => {
    if (sheet._tabs[0].active == "activities" && (data.type == "Macro" || data.type == "Item" || data.type == "Action")) {
        new Promise(async (resolve, reject) => {
            let actor = await fromUuid(MonksPF2EBreaktimeActivities.droptarget);
            if (actor && actor.testUserPermission(game.user, "OWNER")) {
                let breaktime = duplicate(getProperty(actor, "flags.monks-pf2e-breaktime.breaktime") || []);
                breaktime.push({
                    interval: 10,
                    elapsed: 0,
                    uuid: data.uuid
                });
                await actor.setFlag("monks-pf2e-breaktime", "breaktime", breaktime);
                //sheet.render();
            }
        });
        data.type = null;
        return false;
    }
});