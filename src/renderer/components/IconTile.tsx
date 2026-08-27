interface IconTileProps {
  src: string;
  /** Luminosity blending is what greys the colour device photo in the design. */
  desaturate?: boolean;
}

/**
 * The 32px recessed tile that fronts a device or model row (Figma "Overlay",
 * nodes 192:2797, 192:2828 and 225:2191). Figma sizes the tile and its glyph
 * independently, so both dimensions stay explicit.
 */
export function IconTile({ src, desaturate = false }: IconTileProps) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-[8.421px] bg-fill-tile">
      <img
        className={`block size-[16.842px] max-w-none object-contain ${desaturate ? 'mix-blend-luminosity' : ''}`}
        src={src}
        alt=""
      />
    </span>
  );
}
