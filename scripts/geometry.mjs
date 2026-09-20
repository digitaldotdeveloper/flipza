/**
 * Measurements shared between the scripts that generate art and the scripts
 * that cut it up.
 *
 * They live here rather than in either of them because every generator is a
 * top-level script that starts work the moment it is imported - importing
 * gen-oven.mjs to read a rectangle out of it would queue a batch of
 * generations as a side effect.
 *
 * All of them are in plate pixels, measured off sprites-src/plate.png.
 */

/**
 * The oven mouth inside the brick arch. Only the interior: the bricks around
 * it never change, so they are never regenerated.
 */
export const CAVITY = { left: 707, top: 332, width: 300, height: 138 }

/** The same, with enough brick around it for Gemini to see what it is editing. */
export const CONTEXT = { left: 620, top: 268, width: 470, height: 252 }

/**
 * Where the flame frames are composited.
 *
 * Wider than the flames themselves and taller than the cavity: a frame is a
 * fixed-size canvas with the flame standing on its bottom edge, so the rect
 * needs room for the tallest one. The base sits on the ember bed, a little
 * above the hearth floor.
 */
export const FIRE_RECT = { left: 717, top: 318, width: 280, height: 152 }

/**
 * How much picture is added above and below the plate for portrait screens.
 *
 * Above, because the toss needs the room: the pizza's centroid climbs 470px
 * from its rest at y=700 and the sprite is drawn around it, so the top of the
 * arc wants clear picture well above the oven.
 *
 * Below, for a less obvious reason - the dock. On a phone it covers the bottom
 * three tenths of the screen, and with only the original counter underneath it
 * the resting pizza lands *behind* it. Counter added in the foreground pushes
 * the whole scene up the frame until the pizza sits clear above the controls.
 */
export const EXTEND = { top: 560, bottom: 520 }
