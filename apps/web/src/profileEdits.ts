export type Profile = { name: string; title: string; assignment: string };

export type ProfileEdits = Partial<Profile>;

export function savedProfile(bot: { name: string; title?: string; assignment?: string }): Profile {
  return { name: bot.name, title: bot.title ?? "", assignment: bot.assignment ?? "" };
}

export function shownProfile(saved: Profile, edits: ProfileEdits): Profile {
  return { ...saved, ...edits };
}

export function hasChanges(edits: ProfileEdits): boolean {
  return Object.keys(edits).length > 0;
}

export function withEdit(args: { saved: Profile; edits: ProfileEdits; field: keyof Profile; value: string }): ProfileEdits {
  const { [args.field]: _previous, ...rest } = args.edits;
  return args.value === args.saved[args.field] ? rest : { ...rest, [args.field]: args.value };
}
