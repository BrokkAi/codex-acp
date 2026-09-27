import {describe, expect, it} from "vitest";
import {createModelConfigOption, formatModelDisplayName} from "../ModelConfigOption";
import {createTestModel} from "./acp-test-utils";

describe("formatModelDisplayName", () => {
    it.each([
        ["gpt-6-astra", "GPT 6 Astra"],
        ["GPT-5.6-Sol", "GPT 5.6 Sol"],
        ["gpt-5.6-terra", "GPT 5.6 Terra"],
        ["gpt-5.6-luna", "GPT 5.6 Luna"],
        ["gpt-5.5", "GPT 5.5"],
        ["gpt-5.3-codex-spark", "GPT 5.3 Codex Spark"],
        ["gpt-5.3/codex-spark", "GPT 5.3 Codex Spark"],
        ["gpt-oss-120B", "GPT Oss 120B"],
    ])("formats %s as %s", (displayName, expected) => {
        expect(formatModelDisplayName(displayName)).toBe(expected);
    });

    it.each(["GPT 6 Astra", "Claude Opus", "custom-provider/model-v2", "o3-mini"])(
        "preserves non-GPT model name %s",
        (displayName) => {
            expect(formatModelDisplayName(displayName)).toBe(displayName);
        },
    );
});

describe("createModelConfigOption", () => {
    it("preserves the GPT family name without changing model ids", () => {
        const option = createModelConfigOption([
            createTestModel({id: "gpt-6-astra", displayName: "GPT-6-Astra"}),
            createTestModel({id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol"}),
            createTestModel({id: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark"}),
        ], "gpt-5.6-sol");

        expect(option).toMatchObject({
            currentValue: "gpt-5.6-sol",
            options: [
                {value: "gpt-6-astra", name: "GPT 6 Astra"},
                {value: "gpt-5.6-sol", name: "GPT 5.6 Sol"},
                {value: "gpt-5.3-codex-spark", name: "GPT 5.3 Codex Spark"},
            ],
        });
    });
});
