import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { AppShell } from "./AppShell.tsx";
import { useAuthReconnecting } from "./auth.tsx";
import { BotPage } from "./BotPage.tsx";
import { Home } from "./Home.tsx";
import { NotFoundNotice, ProblemNotice } from "./session.tsx";

function RootLayout() {
  const reconnecting = useAuthReconnecting();
  return (
    <>
      {reconnecting && (
        <p className="reconnecting" role="status">
          Reconnecting
        </p>
      )}
      <Outlet />
    </>
  );
}

function RouteError({ error }: ErrorComponentProps) {
  return <ProblemNotice title="Something went wrong" message={error instanceof Error ? error.message : "Unknown error"} />;
}

function NotFound() {
  return <NotFoundNotice title="Page not found" />;
}

const rootRoute = createRootRoute({ component: RootLayout });

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: Home,
});

const botRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/bots/$botId",
  // routine is the routine whose details the routines panel shows.
  validateSearch: (search: Record<string, unknown>): { info?: true; screen?: true; routines?: true; routine?: string } => ({
    ...(search.info === true && { info: true }),
    ...(search.screen === true && { screen: true }),
    ...(search.routines === true && { routines: true }),
    ...(typeof search.routine === "string" && { routine: search.routine }),
  }),
  component: BotPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([appRoute.addChildren([indexRoute, botRoute])]),
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: NotFound,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
