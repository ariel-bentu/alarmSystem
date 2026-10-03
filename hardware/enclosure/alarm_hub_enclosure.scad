// Alarm System Hub Enclosure
// Components:
//   - ESP32-S3 DevKitC-1        70 x 27.9 x 12 mm
//   - CC1101 433MHz module       37 x 23 x 8 mm  (with straight SMA on one end)
//   - LiPo 803450               50 x 34 x 8 mm   (under ESP32-S3)
//   - 134N3P charge module       26 x 17 x 8 mm   (beside LiPo, under CC1101 area)
//
// Layout (top view, inside box):
//   [ ESP32-S3 (70x28)  |  CC1101 (37x23)  ]
//   [ LiPo (50x34)  134N3P(26x17)          ]
//
// SMA bulkhead M7 hole on RIGHT side wall (CC1101 antenna end).
// USB-C for 134N3P on FRONT wall.
// USB-C/micro for ESP32-S3 on FRONT wall.
// Snap-fit lid on top.

// ── Tolerances & wall ──────────────────────────────────────────────
tol       = 0.4;   // clearance on each side of each component
wall      = 2.0;   // shell wall thickness
floor_t   = 1.6;   // floor thickness
snap_h    = 1.2;   // snap tab height
snap_d    = 0.8;   // snap tab depth (overhang)
snap_w    = 8.0;   // snap tab width
lid_t     = 1.8;   // lid thickness
corner_r  = 3.0;   // outer corner radius

// ── Component dimensions ───────────────────────────────────────────
esp_l     = 70.0;  esp_w = 27.9; esp_h = 12.0;
cc_l      = 37.0;  cc_w  = 23.0; cc_h  =  8.0;
lipo_l    = 50.0;  lipo_w = 34.0; lipo_h = 8.0;
charge_l  = 26.0;  charge_w = 17.0; charge_h = 8.0;

// ── Layout geometry ────────────────────────────────────────────────
// Inner width = ESP32 width + gap + CC1101 width (all with tol)
inner_w = (esp_w + 2*tol) + 3.0 + (cc_w + 2*tol);

// Inner length = ESP32 length + tol on each end (CC1101 fits alongside)
inner_l = esp_l + 2*tol;

// Lower tier height = LiPo height + tol + 1mm shelf for PCB standoffs
lower_h = lipo_h + tol + 1.0;

// Upper tier height = ESP32 height + tol + small clearance for wires
upper_h = esp_h + tol + 4.0;

// Total inner height
inner_h = lower_h + upper_h;

// Outer dimensions
outer_w = inner_w + 2*wall;
outer_l = inner_l + 2*wall;
outer_h = inner_h + floor_t;

// X offsets (from inner left wall = 0)
esp_x   = tol;
cc_x    = esp_w + 2*tol + 3.0 + tol;

// Y offsets (from inner front wall = 0)
esp_y   = tol;
lipo_y  = tol;
charge_y = lipo_l + 2*tol + 2.0;

// Z offsets (from inner floor = 0)
lipo_z    = 0;
charge_z  = 0;
esp_z     = lower_h;   // sits on shelf above LiPo
cc_z      = lower_h;

// SMA connector: centre of SMA on CC1101 end (right side wall)
// SMA M7 thread = 6.5mm hole; connector is centred on CC1101 width,
// at mid-height of CC1101 PCB
sma_y = wall + cc_x + cc_w/2;          // Y along outer box
sma_z = floor_t + cc_z + cc_h/2;       // Z from box bottom

// USB-C cutout dims (generous for plug clearance)
usbc_w    = 10.0;  usbc_h = 5.0;

// ESP32-S3 has two USB ports: one at each end of the long axis.
// We expose both on the front and back walls.
// ESP32 USB port positions along its length (approx from datasheet):
//   Boot USB  ~5mm from one end
//   UART USB  ~5mm from other end
// We cut both as slots on front (Y=0) and back (Y=outer_l) walls.

// Position of ESP32 long axis: runs along Y (length) in our layout.
// ESP32 sits at x = esp_x, y = esp_y, z = esp_z inside the box.
// The two USB ports are on the SHORT ends of the ESP32 (Y=front and Y=back).
esp_usb_front_x = wall + esp_x + esp_w/2;  // centre X of ESP32 on front wall
esp_usb_z       = floor_t + esp_z + 2.0;   // Z centre of USB port

// 134N3P USB-C is on the front face of the charge module.
charge_usb_x = wall + charge_y + charge_l/2;  // note: charge module runs along Y
charge_usb_z = floor_t + charge_z + charge_h/2;

// ── Modules ───────────────────────────────────────────────────────

module rounded_box(l, w, h, r) {
    hull() {
        for (x = [r, l-r])
            for (y = [r, w-r])
                translate([x, y, 0]) cylinder(r=r, h=h, $fn=32);
    }
}

module snap_tab(w) {
    // A small triangular snap ridge, extruded along width w
    linear_extrude(w)
        polygon([[0,0],[snap_d,snap_h/2],[0,snap_h]]);
}

// ── Shell (bottom half) ───────────────────────────────────────────
module shell() {
    difference() {
        // Outer body
        rounded_box(outer_l, outer_w, outer_h, corner_r);

        // Hollow interior
        translate([wall, wall, floor_t])
            cube([inner_l, inner_w, inner_h + 1]);

        // ── Cutouts ──────────────────────────────────────────────

        // SMA M7 bulkhead hole on RIGHT side wall (max-X face)
        // Right wall is at X = outer_l
        translate([outer_l - 0.1, sma_y, sma_z])
            rotate([0, 90, 0])
                cylinder(d=7.5, h=wall + 0.2, $fn=32);

        // ESP32-S3 front USB-C slot (Y=0 face, boot USB)
        translate([esp_usb_front_x - usbc_w/2, -0.1, esp_usb_z - usbc_h/2])
            cube([usbc_w, wall + 0.2, usbc_h]);

        // ESP32-S3 back USB-C slot (Y=outer_w face, UART USB)
        translate([esp_usb_front_x - usbc_w/2, outer_w - wall - 0.1, esp_usb_z - usbc_h/2])
            cube([usbc_w, wall + 0.2, usbc_h]);

        // 134N3P USB-C slot on LEFT side wall (X=0 face)
        translate([-0.1, charge_usb_x - usbc_w/2, charge_usb_z - usbc_h/2])
            cube([wall + 0.2, usbc_w, usbc_h]);

        // Lid slot recess: top lip recessed by snap_d so lid sits flush
        translate([wall/2, wall/2, outer_h - snap_h])
            rounded_box(outer_l - wall, outer_w - wall, snap_h + 1, corner_r - wall/2);
    }

    // Snap tabs on inside top rim (4 sides)
    snap_tab_positions();

    // PCB standoffs for ESP32-S3 (4 corners, M2.5, h = lower_h)
    esp32_standoffs();

    // PCB standoffs for CC1101 (2 corners)
    cc1101_standoffs();

    // LiPo retaining walls (thin lips on three sides)
    lipo_retainer();
}

module snap_tab_positions() {
    z = outer_h - snap_h;
    // Front wall (Y=wall, facing inward)
    translate([outer_l/2 - snap_w/2, wall, z])
        snap_tab(snap_w);
    // Back wall
    translate([outer_l/2 - snap_w/2, outer_w - wall - snap_d, z])
        rotate([0,0,180]) translate([-snap_w, 0, 0]) snap_tab(snap_w);
    // Left wall
    translate([wall, outer_w/2 - snap_w/2, z])
        rotate([0,0,90]) snap_tab(snap_w);
    // Right wall
    translate([outer_l - wall - snap_d, outer_w/2 - snap_w/2, z])
        rotate([0,0,270]) translate([-snap_w, 0, 0]) snap_tab(snap_w);
}

module esp32_standoffs() {
    // ESP32-S3 DevKitC-1 mounting holes are 2.5mm from each corner
    // Standoff: 4mm OD, 2mm ID (M2), height = lower_h
    hole_offset = 2.5;
    positions = [
        [wall + esp_x + hole_offset,           wall + esp_y + hole_offset],
        [wall + esp_x + esp_l - hole_offset,   wall + esp_y + hole_offset],
        [wall + esp_x + hole_offset,           wall + esp_y + esp_w - hole_offset],
        [wall + esp_x + esp_l - hole_offset,   wall + esp_y + esp_w - hole_offset]
    ];
    for (p = positions)
        translate([p[0], p[1], floor_t])
            difference() {
                cylinder(d=4.5, h=lower_h, $fn=20);
                cylinder(d=2.2, h=lower_h + 0.1, $fn=20);
            }
}

module cc1101_standoffs() {
    // CC1101 PCB corners (2 holes, simplified)
    hole_offset = 2.0;
    positions = [
        [wall + esp_y + hole_offset,         wall + cc_x + hole_offset],
        [wall + esp_y + cc_l - hole_offset,  wall + cc_x + hole_offset]
    ];
    for (p = positions)
        translate([p[0], p[1], floor_t])
            difference() {
                cylinder(d=4.0, h=lower_h, $fn=20);
                cylinder(d=2.2, h=lower_h + 0.1, $fn=20);
            }
}

module lipo_retainer() {
    // Low lips (3mm tall) to keep LiPo in place
    lip_h = 3.0; lip_t = 1.2;
    // Front lip
    translate([wall + lipo_y, wall + esp_x, floor_t])
        cube([lip_t, lipo_w, lip_h]);
    // Back lip
    translate([wall + lipo_y + lipo_l, wall + esp_x, floor_t])
        cube([lip_t, lipo_w, lip_h]);
    // Side lip (LiPo side facing CC1101 gap)
    translate([wall + lipo_y, wall + esp_x + lipo_w, floor_t])
        cube([lipo_l, lip_t, lip_h]);
}

// ── Lid ──────────────────────────────────────────────────────────
module lid() {
    difference() {
        union() {
            // Flat top panel
            rounded_box(outer_l, outer_w, lid_t, corner_r);
            // Inner skirt that drops into the shell opening
            translate([wall/2, wall/2, -snap_h])
                rounded_box(outer_l - wall, outer_w - wall, snap_h, corner_r - wall/2);
        }
        // Snap notches matching shell tabs
        snap_notch_positions();

        // Small finger-pull recess in centre
        translate([outer_l/2 - 15, outer_w/2 - 5, -0.1])
            cube([30, 10, lid_t * 0.6 + 0.1]);
    }
}

module snap_notch_positions() {
    // Matching recesses for the snap tabs
    translate([outer_l/2 - snap_w/2 - 0.1, 0, -(snap_h - snap_d)])
        cube([snap_w + 0.2, wall/2 + snap_d + 0.2, snap_h]);
    translate([outer_l/2 - snap_w/2 - 0.1, outer_w - wall/2 - snap_d - 0.1, -(snap_h - snap_d)])
        cube([snap_w + 0.2, wall/2 + snap_d + 0.2, snap_h]);
    translate([0, outer_w/2 - snap_w/2 - 0.1, -(snap_h - snap_d)])
        cube([wall/2 + snap_d + 0.2, snap_w + 0.2, snap_h]);
    translate([outer_l - wall/2 - snap_d - 0.1, outer_w/2 - snap_w/2 - 0.1, -(snap_h - snap_d)])
        cube([wall/2 + snap_d + 0.2, snap_w + 0.2, snap_h]);
}

// ── Render ────────────────────────────────────────────────────────
// Shell at origin
shell();

// Lid shown above the shell (exploded view) — move to Z=0 to close it
translate([0, 0, outer_h + 5])
    lid();

// ── Key dimensions echo (visible in console) ─────────────────────
echo("Outer box (L x W x H mm):", outer_l, outer_w, outer_h);
echo("Inner cavity (L x W x H mm):", inner_l, inner_w, inner_h);
echo("SMA hole centre from box bottom (mm):", sma_z);
