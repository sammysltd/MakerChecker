import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";

import { Layout } from "./components/Layout";
import { AgentDetailPage, AgentsPage } from "./pages/AgentsPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { FlowDetailPage, FlowsPage } from "./pages/FlowsPage";
import { RoleDetailPage, RolesPage } from "./pages/RolesPage";
import { RunsListPage } from "./pages/RunsListPage";
import { RunViewerPage } from "./pages/RunViewerPage";
import { SkillDetailPage, SkillsPage } from "./pages/SkillsPage";

const rootRoute = createRootRoute({ component: Layout });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: RunsListPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/runs/$runId", component: RunViewerPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/approvals", component: ApprovalsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/agents", component: AgentsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents/$agentId",
    component: AgentDetailPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/skills", component: SkillsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills/$skillId",
    component: SkillDetailPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/roles", component: RolesPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/roles/$roleId",
    component: RoleDetailPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/flows", component: FlowsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/flows/$flowName",
    component: FlowDetailPage,
  }),
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, ...(history ? { history } : {}) });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
