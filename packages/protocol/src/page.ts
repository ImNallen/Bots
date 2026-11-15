// What an element is in the DOM, read in an isolated world, never from its role attribute or its words. field is line for a
// text-like input, lines for a textarea, secret for a password input, and rich for a contenteditable. choice is a checkbox, radio,
// select, or a role of checkbox, switch, tab, or option. button is everything else the snapshot numbers.
export type PageControl =
  | { kind: "link" }
  | { kind: "submit" }
  | { kind: "field"; field: "line" | "lines" | "secret" | "rich"; readOnly: boolean }
  | { kind: "choice" }
  | { kind: "button" };

// words are the page's own words for the control, as the snapshot shows them. They only describe a card, and no rule reads them
// to let a call run, because a page can call its Post button Read more.
export type PageTarget = { ref: number; words: string; control: PageControl };
