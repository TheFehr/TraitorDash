import { expect, test, describe } from "bun:test";
import { Extractor } from "../src/services/Extractor";

describe("Extractor Sanitization", () => {
  test("should handle C-style comments", async () => {
    const input = "/* multi-line\ncomment */ local a = 1;";
    // @ts-ignore
    const result = Extractor.sanitizeCode(input);
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
