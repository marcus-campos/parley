import { describe, expect, test } from "bun:test";
import { tokenize } from "../../src/brain/tokenize";

describe("tokenising a corpus made of code", () => {
  test("snake_case splits and keeps the whole too", () => {
    expect(tokenize("is_staff()")).toEqual(expect.arrayContaining(["is_staff", "is", "staff"]));
  });

  test("a filename splits on dot and slash", () => {
    const out = tokenize("templates/pages/app/screen_builder.html");
    expect(out).toEqual(expect.arrayContaining(["templates", "pages", "app", "screen", "builder", "html"]));
  });

  test("camelCase splits", () => {
    expect(tokenize("addClassToggle")).toEqual(expect.arrayContaining(["add", "class", "toggle"]));
  });

  test("everything is lowercased", () => {
    expect(tokenize("DIVIDA CONHECIDA")).toEqual(["divida", "conhecida"]);
  });

  test("accents survive, because half the corpus is Portuguese", () => {
    expect(tokenize("menu lateral está com 37px")).toEqual(
      expect.arrayContaining(["menu", "lateral", "está", "37px"]),
    );
  });

  test("a route keeps its shape and its parts", () => {
    const out = tokenize("/setting/reference");
    expect(out).toEqual(expect.arrayContaining(["setting", "reference"]));
  });

  test("empty input is an empty list, not a crash", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
});
