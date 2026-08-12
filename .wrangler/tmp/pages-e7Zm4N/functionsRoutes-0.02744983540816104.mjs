import { onRequestGet as __share__slug__js_onRequestGet } from "c:\\Users\\cesar\\OneDrive\\Documentos\\Moovibe\\functions\\share\\[slug].js"
import { onRequestGet as __lrclib_search_js_onRequestGet } from "c:\\Users\\cesar\\OneDrive\\Documentos\\Moovibe\\functions\\lrclib-search.js"
import { onRequest as __recommend_js_onRequest } from "c:\\Users\\cesar\\OneDrive\\Documentos\\Moovibe\\functions\\recommend.js"

export const routes = [
    {
      routePath: "/share/:slug",
      mountPath: "/share",
      method: "GET",
      middlewares: [],
      modules: [__share__slug__js_onRequestGet],
    },
  {
      routePath: "/lrclib-search",
      mountPath: "/",
      method: "GET",
      middlewares: [],
      modules: [__lrclib_search_js_onRequestGet],
    },
  {
      routePath: "/recommend",
      mountPath: "/",
      method: "",
      middlewares: [],
      modules: [__recommend_js_onRequest],
    },
  ]