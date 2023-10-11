import { i18n } from "./monks-pf2e-encounter-aftermath.js";

export const registerSettings = function () {
    // Register any custom module settings here
    let modulename = "monks-pf2e-encounter-aftermath";

    game.settings.register(modulename, "show-after-combat", {
        name: i18n("monks-pf2e-encounter-aftermath.settings.show-after-combat.name"),
        hint: i18n("monks-pf2e-encounter-aftermath.settings.show-after-combat.hint"),
        scope: "world",
        config: true,
        default: true,
        type: Boolean,
    });
}