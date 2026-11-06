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
  return (
    <section className="notice" role="alert">
      <h2>Something went wrong</h2>
      <p>{error instanceof Error ? error.message : "Unknown error"}</p>
    </section>
  );
}

function NotFound() {
  return (
    <section className="notice">
      <h2>Page not found</h2>
      <p>
        <a href="/">Go to your bots</a>
      </p>
    </section>
  );
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
  validateSearch: (search: Record<string, unknown>): { info?: true; screen?: true } => ({
    ...(search.info === true && { info: true }),
    ...(search.screen === true && { screen: true }),
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
