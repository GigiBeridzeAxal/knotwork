import { describe, expect, it } from "vitest";
import { lookup, render, renderText } from "../shared/template";

const scope = {
  trigger: { body: { id: "o_1", amount: 120, items: [{ name: "Mug" }] } },
  steps: { fetch: { status: 200 } },
};

describe("templates", () => {
  it("keeps the type when the string is one template", () => {
    expect(render("{{ trigger.body.amount }}", scope)).toBe(120);
    expect(render("{{trigger.body.items}}", scope)).toEqual([{ name: "Mug" }]);
  });

  it("interpolates inside text", () => {
    expect(render("Order {{ trigger.body.id }} is {{ steps.fetch.status }}", scope)).toBe("Order o_1 is 200");
    expect(renderText("{{ trigger.body.items.0.name }}!", scope)).toBe("Mug!");
  });

  it("renders nested JSON", () => {
    expect(render({ a: ["{{ trigger.body.id }}", 3], b: { c: "x{{ steps.fetch.status }}" } }, scope)).toEqual({
      a: ["o_1", 3],
      b: { c: "x200" },
    });
  });

  it("leaves missing values empty and never reaches prototypes", () => {
    expect(renderText("[{{ trigger.nope.deeper }}]", scope)).toBe("[]");
    expect(lookup(scope, "trigger.__proto__")).toBeUndefined();
    expect(lookup(scope, "trigger.constructor")).toBeUndefined();
    expect(lookup(scope, "trigger.body.amount + 1")).toBeUndefined();
  });
});
