import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App"
import { applyPlatformAttribute } from "./state/uiStore"
import "./styles/global.css"

// Before the first render, so nothing placed around the macOS traffic lights paints elsewhere first.
applyPlatformAttribute()

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
