import { Dialog } from "./Dialog.tsx";
import { MistralKeySection } from "./MistralKeySection.tsx";

export function SettingsDialog({ email, onClose }: { email: string; onClose: () => void }) {
  return (
    <Dialog title="Settings" onClose={onClose}>
      <section className="settings-section">
        <h3 className="label">Account</h3>
        <div className="card">
          <div className="card-row">{email}</div>
        </div>
      </section>
      <MistralKeySection />
    </Dialog>
  );
}
