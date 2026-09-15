interface IconTileProps {
  src: string;
  /** Luminosity blending is what greys the colour device photo in the design. */
  desaturate?: boolean;
  /**
   * Draws the glyph at the size baked into the asset instead of the shared
   * 16.842px square. The Settings rows front SF Symbol exports whose boxes
   * differ per symbol (15x11 for `arrow.2.squarepath`, 11x14 for
   * `lock.square.stack`), so one square would scale them apart from each other.
   */
  naturalGlyph?: boolean;
}

/**
 * The 32px recessed tile that fronts a device, model, or preference row (Figma
 * "Overlay", nodes 192:2797, 192:2828 and 225:2191; "Background", node
 * 531:5386). Figma sizes the tile and its glyph independently, so both stay
 * explicit.
 */
export function IconTile({ src, desaturate = false, naturalGlyph = false }: IconTileProps) {
  const glyphSize = naturalGlyph ? '' : 'size-[16.842px] object-contain';

  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-[8.421px] bg-fill-tile">
      <img
        className={`block max-w-none ${glyphSize} ${desaturate ? 'mix-blend-luminosity' : ''}`}
        src={src}
        alt=""
      />
    </span>
  );
}
