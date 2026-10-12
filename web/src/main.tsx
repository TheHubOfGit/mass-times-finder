import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Route, Switch } from "wouter";
import { Shell } from "./components/Shell";
import "./index.css";
import { StoreProvider } from "./lib/store";
import { ChurchPage } from "./pages/Church";
import { MapPage } from "./pages/MapPage";
import { Nearby } from "./pages/Nearby";
import { Saved } from "./pages/Saved";
import { Search } from "./pages/Search";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: true } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <StoreProvider>
        <Shell>
          <Switch>
            <Route path="/" component={Nearby} />
            <Route path="/map" component={MapPage} />
            <Route path="/search" component={Search} />
            <Route path="/saved" component={Saved} />
            <Route path="/church/:id">{(p) => <ChurchPage id={p.id} />}</Route>
            <Route><Nearby /></Route>
          </Switch>
        </Shell>
      </StoreProvider>
    </QueryClientProvider>
  </StrictMode>,
);
