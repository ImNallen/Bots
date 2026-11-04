import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { Home } from "./Home.tsx";

function RootLayout() {
  return (
    <>
      <header className="site-header">
        <h1>Bots</h1>
      </header>
      <main>
        <Outlet />
      </main>
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

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute]),
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: NotFound,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
