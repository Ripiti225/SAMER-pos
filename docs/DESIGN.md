---
name: Culinary Commerce
colors:
  surface: '#fff8f2'
  surface-dim: '#dfd9d3'
  surface-bright: '#fff8f2'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f9f3ec'
  surface-container: '#f3ede6'
  surface-container-high: '#ede7e1'
  surface-container-highest: '#e7e2db'
  on-surface: '#1d1b17'
  on-surface-variant: '#524435'
  inverse-surface: '#32302c'
  inverse-on-surface: '#f6f0e9'
  outline: '#857462'
  outline-variant: '#d7c3ae'
  surface-tint: '#855400'
  primary: '#855400'
  on-primary: '#ffffff'
  primary-container: '#ef9f27'
  on-primary-container: '#603b00'
  inverse-primary: '#ffb95d'
  secondary: '#875200'
  on-secondary: '#ffffff'
  secondary-container: '#ffb153'
  on-secondary-container: '#724400'
  tertiary: '#665d4b'
  on-tertiary: '#ffffff'
  tertiary-container: '#baaf99'
  on-tertiary-container: '#4a4231'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffddb7'
  primary-fixed-dim: '#ffb95d'
  on-primary-fixed: '#2a1700'
  on-primary-fixed-variant: '#653e00'
  secondary-fixed: '#ffddba'
  secondary-fixed-dim: '#ffb866'
  on-secondary-fixed: '#2b1700'
  on-secondary-fixed-variant: '#673d00'
  tertiary-fixed: '#eee1ca'
  tertiary-fixed-dim: '#d1c5af'
  on-tertiary-fixed: '#211b0c'
  on-tertiary-fixed-variant: '#4e4635'
  background: '#fff8f2'
  on-background: '#1d1b17'
  surface-variant: '#e7e2db'
typography:
  display-lg:
    fontFamily: Work Sans
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Work Sans
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Work Sans
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  title-lg:
    fontFamily: Work Sans
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Work Sans
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 26px
  body-md:
    fontFamily: Work Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-lg:
    fontFamily: Work Sans
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0.02em
  label-md:
    fontFamily: Work Sans
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 8px
  margin-page: 24px
  gutter: 16px
  padding-card: 20px
  touch-target-min: 48px
---

## Brand & Style

The design system is engineered for high-volume hospitality environments, balancing the warmth of a boutique restaurant with the rigorous efficiency required for point-of-sale operations. The personality is welcoming yet authoritative, utilizing a "Warm Professional" aesthetic that avoids the sterile coldness of traditional enterprise software.

The style leans into **Modern Tactility**. It utilizes soft elevations and generous touch targets to reduce cognitive load during fast-paced service. By combining a "paper-like" background with high-fidelity surface depth, the interface provides a clear mental model of layered functionality, ensuring that primary actions are physically intuitive and secondary controls remain accessible but non-distracting.

## Colors

This design system utilizes a foundation of warm neutrals to prevent eye strain during long shifts. The palette is anchored by a vibrant orange primary color, used strategically for "Call to Action" elements and active states.

- **Warm Foundation:** Avoid pure white (#ffffff) for large surfaces; use the Page Background to create a comfortable, low-glare environment.
- **Surface Hierarchy:** Use the Card Surface for interactive containers and the Soft Surface for secondary background regions or disabled states.
- **Semantic Clarity:** Success, Alert, and Info colors are calibrated for high legibility against the warm background, ensuring critical status updates are immediately recognizable.

## Typography

The typography system relies on **Work Sans** for its exceptional legibility and professional character. Given the desktop/tablet POS context, font sizes are slightly oversized to ensure readability from a distance (arm's length).

- **Hierarchy:** Use `Display` and `Headline` roles for totals, order numbers, and table identifiers.
- **Body:** `Body-lg` is the default for menu item descriptions and guest notes.
- **Labels:** Use `Label-lg` in all-caps for column headers or secondary metadata to create a clear visual distinction from interactive data.
- **Weight:** Avoid weights below 400 to maintain contrast against the warm tinted backgrounds.

## Layout & Spacing

The layout follows a **Fluid 12-Column Grid** on desktop, transitioning to a flexible 8-column layout on smaller tablets.

- **The 8px Rule:** All spacing, margins, and component heights must be multiples of 8px to ensure a consistent rhythmic flow.
- **Density:** Maintain "Generous Whitespace" to prevent mis-taps. Vertical rhythm between menu items should prioritize clarity over information density.
- **Safe Zones:** Ensure a 24px margin around the edges of the screen to account for tablet bezels and accidental palm touches.

## Elevation & Depth

Hierarchy is established through **Ambient Shadows** and tonal layering. The system avoids harsh borders in favor of soft, diffused shadows that suggest the physical presence of objects.

- **Level 0 (Background):** Page Background (#f5f2ea), no shadow.
- **Level 1 (Cards):** Surface Card (#ffffff) with a 4px blur, 2% opacity black shadow.
- **Level 2 (Interactive/Hover):** Surface Card with an 8px blur, 6% opacity black shadow.
- **Level 3 (Modals/Overlays):** Surface Card with a 24px blur, 12% opacity shadow, tinted slightly with the secondary color (#b06f12) to maintain the warm theme.
- **Outlines:** Use the Border color (#ece8df) for static containers that do not require elevation.

## Shapes

The shape language is defined by significant corner rounding, reinforcing the "friendly" and "accessible" brand pillars.

- **Main Containers:** Use the `--rayon` token (16px) for cards, modals, and primary containers.
- **Interactive Elements:** Use the `--rayon-btn` token (13px) for buttons, input fields, and selection chips.
- **Consistency:** Rounding should be nested; inner elements should have a slightly smaller radius than their parent containers to maintain visual harmony.

## Components

### Buttons
- **Primary:** Background #ef9f27, Text #ffffff, Height min 48px, Radius 13px. Uses a soft bottom-aligned shadow to appear "pressable."
- **Secondary:** Background #fbeed6, Text #b06f12, No shadow.
- **Tactile Feedback:** On press, buttons should shift 1px down and reduce shadow spread to simulate physical displacement.

### Cards & Menu Items
- Cards must use the 16px radius and Level 1 elevation.
- Menu items should include high-fidelity imagery with a top-only 16px radius, or use a soft surface color for text-only variations.

### Form Inputs
- Fields must be 48px minimum height for touch accessibility.
- Border-color #ece8df is default; changes to Primary #ef9f27 on focus with a 2px stroke.

### Selection & Status
- **Chips:** Used for modifiers (e.g., "Extra Cheese"). 13px radius, Soft Surface background, Text Soft color.
- **Success/Alert Labels:** Small capsules with 100px radius, using the respective semantic colors at 10% opacity for backgrounds and 100% opacity for text.

### Navigation
- A vertical sidebar on the left using the Soft Surface color to differentiate from the main workspace. Active items use a 4px primary-colored left-indicator bar.
