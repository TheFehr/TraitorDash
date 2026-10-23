import { WebGLRenderer, Scene, PerspectiveCamera, HemisphereLight, AmbientLight, DirectionalLight, Color } from 'three'

/** What the map view and the replay start from: the same renderer, lit scene and camera, so a map looks the same in both. */

/** The dark background of the drawing: the canvas's own colour in the page stylesheet (#14110e). */
export const BACKGROUND = 0x14110e

/** A renderer on the canvas, with clipping on (the level cutaway) and the pixel ratio capped at 2. Throws without WebGL. */
export function makeRenderer(canvas: HTMLCanvasElement): WebGLRenderer {
  const renderer = new WebGLRenderer({ canvas, antialias: true })
  renderer.localClippingEnabled = true
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  return renderer
}

/** A scene with the dark background and the three lights. */
export function makeScene(): Scene {
  const scene = new Scene()
  scene.background = new Color(BACKGROUND)
  scene.add(new HemisphereLight(0xffffff, 0x555566, 1.4), new AmbientLight(0xffffff, 0.9))
  const sun = new DirectionalLight(0xffffff, 1.6)
  sun.position.set(-1, 2, 1.2)
  scene.add(sun)
  return scene
}

/** The perspective camera both views use. */
export const makeCamera = (): PerspectiveCamera => new PerspectiveCamera(40, 1, 1, 200000)
