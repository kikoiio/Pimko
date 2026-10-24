export interface SubtitleAppearance {
  visible?: boolean
  size?: 'small' | 'medium' | 'large'
  position?: 'top' | 'center' | 'bottom'
  style?: 'bold' | 'minimal'
}

export function isSubtitleAppearance(value: unknown): value is SubtitleAppearance {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'visible') {
      if (typeof entry !== 'boolean') return false
    } else if (key === 'size') {
      if (entry !== 'small' && entry !== 'medium' && entry !== 'large') return false
    } else if (key === 'position') {
      if (entry !== 'top' && entry !== 'center' && entry !== 'bottom') return false
    } else if (key === 'style') {
      if (entry !== 'bold' && entry !== 'minimal') return false
    } else return false
  }
  return true
}
