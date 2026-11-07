import { useState, type ReactNode } from "react";
import { AboutSection } from "./AboutSection.tsx";
import { DialogFrame } from "./Dialog.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { MistralKeySection } from "./MistralKeySection.tsx";
import { TimeZoneSection } from "./TimeZoneSection.tsx";

const SECTIONS = {
  general: { label: "General", icon: "gear" },
  mistralKey: { label: "Mistral key", icon: "key" },
} as const satisfies Record<string, { label: string; icon: IconName }>;

type Section = keyof typeof SECTIONS;

const SECTION_IDS = Object.keys(SECTIONS) as Section[];

// Each pane stays mounted, so leaving one keeps a typed key, a check in progress, and an error. A phone shows every pane.
function Pane({ id, open, children }: { id: Section; open: Section; children: ReactNode }) {
  return (
    <section className="set-section" data-open={id === open}>
      <h2>{SECTIONS[id].label}</h2>
      {children}
    </section>
  );
}

export function SettingsDialog({ email, onClose }: { email: string; onClose: () => void }) {
  const [open, setOpen] = useState<Section>("general");
  return (
    <DialogFrame title="Settings" className="dialog dialog-wide" onClose={onClose}>
      <div className="set-box">
        {/* First in the order, so a phone's first focus is not the key field, which would open the keyboard. */}
        <button type="button" className="icon-button set-close" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
        <nav className="set-nav" aria-label="Settings sections">
          {SECTION_IDS.map((id) => (
            <button key={id} type="button" aria-current={id === open ? "true" : undefined} onClick={() => setOpen(id)}>
              <Icon name={SECTIONS[id].icon} />
              {SECTIONS[id].label}
            </button>
          ))}
        </nav>
        <div className="set-main">
          <Pane id="general" open={open}>
            <h3 className="label">Account</h3>
            <div className="card">
              <div className="card-row">{email}</div>
            </div>
            <h3 className="label">About you</h3>
            <AboutSection />
            <h3 className="label">Time zone</h3>
            <TimeZoneSection />
          </Pane>
          <Pane id="mistralKey" open={open}>
            <MistralKeySection />
          </Pane>
        </div>
      </div>
    </DialogFrame>
  );
}
