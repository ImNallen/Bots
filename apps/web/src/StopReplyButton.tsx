import { Icon } from "./Icon.tsx";

export function StopReplyButton({ stopping, onStop }: { stopping: boolean; onStop: () => void }) {
  const label = stopping ? "Stopping reply" : "Stop reply";
  return <button type="button" className={stopping ? "send send-stopping" : "send send-stop"} aria-label={label} title={label} disabled={stopping} onClick={onStop}>
    <Icon name="stop" />
  </button>;
}
