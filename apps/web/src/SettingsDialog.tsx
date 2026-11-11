import { api } from "@bots/convex";
import { useQuery } from "convex/react";
import { useState, type ReactNode } from "react";
import { AboutSection } from "./AboutSection.tsx";
import { ComputerSection } from "./ComputerSection.tsx";
import { readAppearance, setAppearance, type Appearance } from "./appearance.ts";
import { DialogFrame } from "./Dialog.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { MistralKeySection } from "./MistralKeySection.tsx";
import { TimeZoneSection } from "./TimeZoneSection.tsx";

const SECTIONS = {
  general: { label: "General", icon: "user" },
  mistralKey: { label: "Mistral key", icon: "key" },
} as const satisfies Record<string, { label: string; icon: IconName }>;

type Section = keyof typeof SECTIONS;

const SECTION_IDS = Object.keys(SECTIONS) as Section[];

// Keep drafts and in-flight key checks when switching sections.
function Pane({ id, open, children }: { id: Section; open: Section; children: ReactNode }) {
  return (
    <section className="set-section" data-open={id === open}>
      <h2>{SECTIONS[id].label}</h2>
      {children}
    </section>
  );
}

export function SettingsDialog({ email, onClose }: { email: string; onClose: () => void }) {
  const user = useQuery(api.users.current);
  const name = user?.displayName ?? email;
  const [open, setOpen] = useState<Section>("general");
  const [appearance, chooseAppearance] = useState(readAppearance);
  return (
    <DialogFrame title="Settings" className="dialog dialog-wide" onClose={onClose}>
      <div className="set-box">
        {/* First in the order, so a phone's first focus is not the key field, which would open the keyboard. */}
        <button type="button" className="icon-button set-close" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
        <nav className="set-nav" aria-label="Settings sections">
          <h1>Settings</h1>
          {SECTION_IDS.map((id) => (
            <button key={id} type="button" aria-current={id === open ? "true" : undefined} onClick={() => setOpen(id)}>
              <Icon name={SECTIONS[id].icon} />
              {SECTIONS[id].label}
            </button>
          ))}
        </nav>
        <div className="set-main">
          <Pane id="general" open={open}>
            <p className="set-intro">A few things that make Bots feel like yours.</p>
            <div className="card account-card">
              <span className="me-dot">{name.split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("").toUpperCase()}</span>
              <div><strong>{name}</strong><small>{email}</small></div>
            </div>
            <AboutSection />
            <TimeZoneSection />
            <ComputerSection />
            <div className="card appearance-setting">
              <div><h3>Appearance</h3><small>Make yourself comfortable.</small></div>
              <div className="appearance-options" role="group" aria-label="Appearance">
                {(["system", "light", "dark"] satisfies Appearance[]).map((value) => (
                  <button key={value} type="button" aria-pressed={appearance === value} onClick={() => { chooseAppearance(value); setAppearance(value); }}>{value.charAt(0).toUpperCase() + value.slice(1)}</button>
                ))}
              </div>
            </div>
          </Pane>
          <Pane id="mistralKey" open={open}>
            <MistralKeySection />
          </Pane>
        </div>
      </div>
    </DialogFrame>
  );
}
