import { type Ref } from "react";
import { CatRenderer, type CatRendererHandle } from "./CatRenderer";

/**
 * Presentational shell for the overlay. It renders nothing but the transparent
 * cat canvas; all pointer handling and click-through toggling is orchestrated
 * imperatively in App (driven by the global cursor), so the DOM stays trivial.
 */
export function Overlay({ rendererRef }: { rendererRef: Ref<CatRendererHandle> }) {
  return <CatRenderer ref={rendererRef} />;
}
