# Technical Specification: FIFA-Compliant Professional Stadium Lighting

This document outlines the technical requirements and spatial configurations necessary to achieve **FIFA Lighting Class V (Elite Level / UHD Broadcasting)** standards for a football stadium.

---

## 1. Light Source Characteristics
Modern professional stadiums strictly utilize **High-Power LED Floodlights**.

*   **Luminous Flux:** ~150,000 – 180,000 Lumens per fixture.
*   **Power Consumption:** 1200W – 1600W per module.
*   **CCT (Color Temperature):** **5600K** (Daylight). Crucial for 4K/UHD camera white balance.
*   **CRI (Color Rendering Index):** $Ra \ge 80$ (Standard) to $90+$ (Elite).
*   **TLCI (Television Lighting Consistency Index):** $> 90$. This is the "gold standard" for digital sensor color accuracy.
*   **Flicker Factor:** $< 1\%$. Required for flicker-free super-slow-motion (1000 fps).
*   **Beam Angles:** A mix of **Narrow (10°-15°)** for the center of the pitch and **Medium (25°-40°)** for closer areas.

---

## 2. Quantitative Illuminance Targets (FIFA Class V)
To pass inspection, the following values must be achieved across the entire 105m x 68m pitch.

| Metric | Target Value | Description |
| :--- | :--- | :--- |
| **$E_h$ (Horizontal)** | **2000 – 3500 lux** | Light falling on the grass surface. |
| **$E_v$ (Vertical)** | **1500 – 2000 lux** | Light hitting the players (facing the 4 main camera sides). |
| **$U_1$ (Uniformity)** | **$\ge 0.7$** | Ratio of minimum lux to average lux. |
| **$U_2$ (Uniformity)** | **$\ge 0.8$** | Ratio of minimum lux to maximum lux. |
| **Glare Rating ($GR$)** | **$< 50$** | Prevents blinding players and spectators. |

---

## 3. Physical Placement & Geometry
In a "Coliseum-style" stadium, lights are mounted on the inner edge of the roof (catwalks).

### Layout & Quantity
*   **Total Fixtures:** Typically **280 to 450 units** depending on the specific LED model.
*   **Configuration:** A continuous "Ribbon of Light" along the long sides (East/West) and corners.
*   **Goal Zone Exclusion:** To prevent blinding the goalkeeper, no lights should be placed within a **$20^{\circ}$ zone** relative to the goal line (extending from the center of the goal).

### Height & Angles
*   **Mounting Height ($H$):** Standard is **45m to 55m** above the pitch. Minimum is 30m.
*   **Aiming Angle:** The angle between the light beam and the horizontal must be **$\le 70^{\circ}$** (to avoid "raccoon eye" shadows) and **$> 25^{\circ}$** (to avoid direct glare).
*   **Cross-Firing Strategy:** 
    *   Lamps on the West roof should aim at the East half of the pitch.
    *   Lamps on the East roof should aim at the West half.
    *   *Why:* This "cross-fire" ensures that $E_v$ (Vertical Illuminance) is high enough for cameras on both sides.

---

## 4. Verification & Measurement
FIFA uses a grid-based system for auditing.

*   **The Grid:** The pitch is divided into a grid of **11 x 11 (121 points)** or **13 x 9 (117 points)**.
*   **Horizontal Measurement:** Sensor placed on the ground, facing upwards.
*   **Vertical Measurement:** Sensor held 1.5m above the ground, facing each of the four stands (Camera directions).
*   **Maintenance Factor:** For 3D simulation, assume a factor of **0.8** (accounting for lens dust and aging over time).

---

## 5. 3D Modeling (Blender) Implementation Guide

If you are setting this up in Blender to match these specs:

1.  **Scale:** Set your Scene Units to **Meters**. Create a plane **105m x 68m**.
2.  **Light Type:** Use **Area Lights** but assign them an **IES Profile** (Photometric data). *Search for "Philips ArenaVision LED IES" for authentic data.*
3.  **Array:** Create an array of lights along the inner roof line at **45m height**.
4.  **Targeting:** 
    *   Create a grid of Empty objects on the pitch.
    *   Use a **Track To** constraint on each lamp to point it at a specific Empty.
    *   Distribute the targets evenly to ensure $U_1$ uniformity.
5.  **Rendering/Analysis:**
    *   Use **Cycles** (it is a physically-based path tracer).
    *   Enable **False Color** in the Color Management tab.
    *   Calibrate the exposure so that the pitch surface falls into the "High/White" range corresponding to ~2500 lux.