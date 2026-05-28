/**
 * Convert World Atlas 2015 artificial zenith brightness (mcd/m²) to SQM (mag/arcsec²).
 *
 * Uses the same zero-point convention as src/utils.js radianceToSqm so that "no
 * artificial light" maps to exactly 22.0 (Bortle 1): the artificial brightness is
 * expressed as a ratio over the natural sky background, then subtracted in magnitudes.
 *   SQM = 22.0 - 2.5*log10(1 + artificial / naturalBackground)
 * Natural background = 0.174 mcd/m² ≈ 22 mag/arcsec² (Falchi et al. 2016).
 */
const NATURAL_MCD = 0.174;

export function brightnessToSqm(artificialMcd) {
  if (artificialMcd == null || artificialMcd <= 0) return 22.0;
  const sqm = 22.0 - 2.5 * Math.log10(1 + artificialMcd / NATURAL_MCD);
  return Math.min(22.0, Math.max(16.0, Math.round(sqm * 100) / 100));
}
