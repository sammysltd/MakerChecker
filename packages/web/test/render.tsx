import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, type RenderResult } from "@testing-library/react";

import { createAppRouter } from "../src/router";

interface AppRenderResult extends RenderResult {
  router: ReturnType<typeof createAppRouter>;
  queryClient: QueryClient;
}

/** Mount the full app (router + query client) at a given path. */
export function renderApp(path: string): AppRenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, router, queryClient };
}
