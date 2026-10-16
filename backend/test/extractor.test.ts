import { expect, test, describe } from "bun:test";
import { Extractor } from "../src/services/Extractor";
import { ExtractorCore } from "../src/services/ExtractorCore";

describe("Extractor Sanitization", () => {
  test("should handle C-style comments", async () => {
    const input = "/* multi-line\ncomment */ local a = 1;";
    // @ts-ignore
    const result = (ExtractorCore as any).sanitizeCode(input);
    expect(result).toContain("--[[ multi-line\ncomment ]]");
  });

  test("should handle GMod operators in complex role code", async () => {
    const roleCode = `
      /* GMod Style Comment */
      if CLIENT && !SERVER || false && (1 != 2) then
        // Single line
        ROLE.name = "test"
      end
      
      function ROLE:AddToSettingsMenu(parent)
        parent:MakeCheckbox({ label = "Test" })
      end
    `;

    const { schema } = await Extractor.extractSchema(roleCode);
    expect(schema).toBeArray();
    expect(schema[0].type).toBe("MakeCheckbox");
  });
});

describe("Extractor Schema Extraction", () => {
  test("should handle basic role code without crashing", async () => {
    const roleCode = `
      if SERVER then
        AddCSLuaFile()
      end
      
      ROLE.name = "test_role"
      
      function ROLE:AddToSettingsMenu(parent)
        parent:MakeCheckbox({
          label = "Test Checkbox",
          convar = "ttt_test_convar"
        })
      end
    `;

    const { schema, team } = await Extractor.extractSchema(roleCode);
    expect(schema).toBeArray();
    expect(schema[0].type).toBe("MakeCheckbox");
    expect(schema[0].args.label).toBe("Test Checkbox");
    expect(team).toBe("innocents");
  });

  test("should resolve translation keys using captured LANG:AddToLanguage calls", async () => {
    const roleCode = `
      if CLIENT then
        LANG.AddToLanguage("en", "test_label_key", "Translated Label")
      end
      
      function ROLE:AddToSettingsMenu(parent)
        parent:MakeCheckbox({
          label = "test_label_key",
          convar = "ttt_test_translation"
        })
      end
    `;

    const { schema } = await Extractor.extractSchema(roleCode);
    expect(schema).toBeArray();
    expect(schema[0].args.label).toBe("Translated Label");
  });

  test("should handle LANG.GetLanguageTableReference for manual translation insertion", async () => {
    const roleCode = `
      if CLIENT then
        local L = LANG.GetLanguageTableReference("en")
        L["manual_key"] = "Manual Translation"
      end
      
      function ROLE:AddToSettingsMenu(parent)
        parent:MakeCheckbox({
          label = "manual_key",
          convar = "ttt_test_manual"
        })
      end
    `;

    const { schema } = await Extractor.extractSchema(roleCode);
    expect(schema).toBeArray();
    expect(schema[0].args.label).toBe("Manual Translation");
  });

  test("should handle conditional UI elements based on injected ConVar state", async () => {
    const roleCode = `
      function ROLE:AddToSettingsMenu(parent)
        if GetConVar("ttt_feature_enabled"):GetBool() then
          parent:MakeCheckbox({ label = "Enabled Feature" })
        else
          parent:MakeCheckbox({ label = "Disabled Feature" })
        end
      end
    `;

    // Test with feature ENABLED
    const enabled = await Extractor.extractSchema(roleCode, { "ttt_feature_enabled": "1" });
    expect(enabled.schema[0].args.label).toBe("Enabled Feature");

    // Test with feature DISABLED
    const disabled = await Extractor.extractSchema(roleCode, { "ttt_feature_enabled": "0" });
    expect(disabled.schema[0].args.label).toBe("Disabled Feature");
  });

  test("should handle undefined global role constants (e.g. JACKAL) via metatable", async () => {
    const roleCode = `
      function ROLE:AddToSettingsMenu(parent)
        -- Reference a global that isn't explicitly defined in mock_env
        local otherIndex = SOME_NEW_ROLE.index
        
        parent:MakeCheckbox({
          label = "Test with " .. tostring(otherIndex),
          convar = "ttt_test_dynamic"
        })
      end
    `;

    const { schema } = await Extractor.extractSchema(roleCode);
    expect(schema).toBeArray();
    expect(schema[0].args.label).toBe("Test with 100");
  });
});

describe("Extractor conVarData ConVar names", () => {
  // Real ConVar names, as listed by `find ttt_surv` / `find ttt_det` on a live TTT2 server.
  const surv = `
    function ROLE:PreInitialize()
      self.abbr = "surv"
      self.conVarData = {
        pct = 0.15, maximum = 2, minPlayers = 7, minKarma = 400,
        credits = 1, creditsAwardDeadEnable = 1, creditsAwardKillEnable = 0,
        togglable = true, shopFallback = "detective"
      }
    end
  `;

  test("uses the role name for some settings and the abbr for others", async () => {
    const { schema } = await Extractor.extractSchema(surv, undefined, undefined, "survivalist");
    const byKey = Object.fromEntries(schema.map((i: any) => [i.args.key, i.args.convar]));

    expect(byKey.pct).toBe("ttt_survivalist_pct");
    expect(byKey.maximum).toBe("ttt_survivalist_max");
    expect(byKey.minPlayers).toBe("ttt_survivalist_min_players");
    expect(byKey.minKarma).toBe("ttt_survivalist_karma_min");
    expect(byKey.togglable).toBe("ttt_survivalist_enabled");
    expect(byKey.credits).toBe("ttt_surv_credits_starting");
    expect(byKey.creditsAwardDeadEnable).toBe("ttt_surv_credits_award_dead_enb");
    expect(byKey.creditsAwardKillEnable).toBe("ttt_surv_credits_award_kill_enb");
    expect(byKey.shopFallback).toBe("ttt_surv_shop_fallback");
  });

  test("same rule for the detective (name != abbr)", async () => {
    const det = surv.replace('"surv"', '"det"');
    const { schema } = await Extractor.extractSchema(det, undefined, undefined, "detective");
    const byKey = Object.fromEntries(schema.map((i: any) => [i.args.key, i.args.convar]));

    expect(byKey.pct).toBe("ttt_detective_pct");
    expect(byKey.minKarma).toBe("ttt_detective_karma_min");
    expect(byKey.credits).toBe("ttt_det_credits_starting");
    expect(byKey.shopFallback).toBe("ttt_det_shop_fallback");
  });

  test("an unknown conVarData key is guessed under the role name and flagged", async () => {
    const code = `function ROLE:PreInitialize() self.abbr = "x" self.conVarData = { someNewThing = 5 } end`;
    const { schema } = await Extractor.extractSchema(code, undefined, undefined, "myrole");
    expect(schema[0].args.convar).toBe("ttt_myrole_some_new_thing");
    expect(schema[0].args.guessed).toBe(true);
  });
});

describe("Extractor language files", () => {
  const role = `
    function ROLE:AddToSettingsMenu(parent)
      parent:MakeSlider({ label = "label_med_armor", convar = "ttt_med_armor", min = 0, max = 100 })
      parent:MakeCheckBox({ label = "label_roles_enabled", convar = "ttt_med_enabled" })
      parent:MakeCheckBox({ label = "label_never_defined", convar = "ttt_med_x" })
    end
  `;
  // The two shapes real files use: TTT2 core (LANG.CreateLanguage) and role addons (GetLanguageTableReference / AddToLanguage).
  const core = `local L = LANG.CreateLanguage("en")\nL.label_roles_enabled = "Enable role"\nL.greeting = "Hello, terrorist!"`;
  const addon = `local L = LANG.GetLanguageTableReference("en")\nL["label_med_armor"] = "Armor of the medic"`;

  test("translation keys resolve from pushed language files", async () => {
    const { schema } = await Extractor.extractSchema(role, undefined, undefined, "medic", [core, addon]);
    const labels = schema.map((i: any) => i.args.label);
    expect(labels).toContain("Armor of the medic");
    expect(labels).toContain("Enable role");
  });

  test("a key nobody defines is still shown as [key], so it is visible that it is missing", async () => {
    const { schema } = await Extractor.extractSchema(role, undefined, undefined, "medic", [core, addon]);
    expect(schema.map((i: any) => i.args.label)).toContain("[label_never_defined]");
  });

  test("without language files the keys stay unresolved (the old behaviour)", async () => {
    const { schema } = await Extractor.extractSchema(role);
    expect(schema[0].args.label).toBe("[label_med_armor]");
  });

  test("language text is loaded raw: '!' and '//' in translations survive", async () => {
    const lang = `local L = LANG.CreateLanguage("en")\nL.label_x = "Wow! See http://example.com // now"`;
    const code = `function ROLE:AddToSettingsMenu(parent) parent:MakeCheckBox({ label = "label_x", convar = "ttt_x" }) end`;
    const { schema } = await Extractor.extractSchema(code, undefined, undefined, "r", [lang]);
    expect(schema[0].args.label).toBe("Wow! See http://example.com // now");
  });

  test("a broken language file is skipped and the others still load", async () => {
    const { schema } = await Extractor.extractSchema(role, undefined, undefined, "medic", ["this is not lua ((", core, addon]);
    expect(schema.map((i: any) => i.args.label)).toContain("Armor of the medic");
  });
});
