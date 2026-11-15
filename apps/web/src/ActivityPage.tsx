import { api } from "@bots/convex";
import { Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import type { ReactNode } from "react";
import { quietWords, withoutMarkdown } from "./activity.ts";
import { BotFace } from "./BotFace.tsx";
import { characterOf } from "./character.ts";
import { timeLabel } from "./conversation.ts";
import { Icon } from "./Icon.tsx";
import { routineStatus, runStateWords } from "./routines.ts";
import { useIsPhone } from "./useIsPhone.ts";

type Page = FunctionReturnType<typeof api.activity.page>;
type Clock = { now: number; locale: string };

function RowLink(props: { bot: Page["runs"][number]["bot"]; atRoutines: boolean; children: ReactNode }) {
  const { bot, atRoutines, children } = props;
  const isPhone = useIsPhone();
  return (
    <Link className="activity-row" to="/bots/$botId" params={{ botId: bot._id }} search={atRoutines ? { info: true, routines: true } : {}}>
      <BotFace character={characterOf(bot)} size={isPhone ? 44 : 32} />
      <span className="activity-text">{children}</span>
    </Link>
  );
}

function RunRow({ row, clock }: { row: Page["runs"][number]; clock: Clock }) {
  const isRoutine = row.trigger === "schedule";
  const { words, tone } = runStateWords(row.state);
  return (
    <li>
      <RowLink bot={row.bot} atRoutines={isRoutine}>
        <span className="activity-top">
          <span className="row-name">{row.bot.name}</span>
          <span className="activity-when">{timeLabel({ at: row.createdAt, now: clock.now, locale: clock.locale })}</span>
        </span>
        <span className="activity-line">
          {isRoutine ? "Routine" : "Chat"}. <span data-tone={tone}>{words}</span>
        </span>
        {isRoutine && <span className="activity-line activity-clip">{row.title ?? "A routine you deleted"}</span>}
        {row.blocked && (
          <span className="activity-blocked">
            <Icon name="shield" />
            Blocked an attempt to change something
          </span>
        )}
        {row.lastText !== null && <span className="activity-said">{withoutMarkdown(row.lastText)}</span>}
        {row.quiet !== null && <span className="activity-said">{quietWords(row.quiet.reason)}</span>}
      </RowLink>
    </li>
  );
}

function UpcomingRow({ row, clock, timeZone }: { row: Page["upcoming"][number]; clock: Clock; timeZone: string }) {
  return (
    <li>
      <RowLink bot={row.bot} atRoutines>
        <span className="row-name">{row.bot.name}</span>
        <span className="activity-said">{row.title}</span>
        <span className="activity-line">
          {row.when}. {routineStatus(row, { ...clock, timeZone })}
        </span>
        {row.lastMissed !== undefined && (
          <span className="activity-line">
            Missed {timeLabel({ at: row.lastMissed.at, now: clock.now, locale: clock.locale })}. {row.lastMissed.reason}
          </span>
        )}
      </RowLink>
    </li>
  );
}

export function ActivityPage() {
  const page = useQuery(api.activity.page);
  const clock = { now: Date.now(), locale: navigator.language };
  return (
    <div className="activity">
      <div className="activity-column">
        <header className="activity-head">
          <Link to="/" className="round chat-back" aria-label="Your bots">
            <Icon name="back" />
          </Link>
          <h2>Activity</h2>
        </header>
        {page === undefined && (
          <p className="session-status" role="status">
            Loading activity.
          </p>
        )}
        {page?.upcoming.length === 0 && page.runs.length === 0 && (
          <div className="start">
            <strong>Nothing here yet</strong>
            <span>What your bots run, and the routines they have coming up, show here.</span>
          </div>
        )}
        {page !== undefined && page.upcoming.length > 0 && (
          <section>
            <h3 className="label">Upcoming</h3>
            <ul className="card activity-rows">
              {page.upcoming.map((row) => (
                <UpcomingRow key={row._id} row={row} clock={clock} timeZone={page.timeZone} />
              ))}
            </ul>
          </section>
        )}
        {page !== undefined && page.runs.length > 0 && (
          <section>
            <h3 className="label">Recent runs</h3>
            <ul className="card activity-rows">
              {page.runs.map((row) => (
                <RunRow key={row._id} row={row} clock={clock} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
