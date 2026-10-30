# Local USB bench panel

Use desktop Chrome and the Nucleo ST-LINK virtual COM port. Serial is 115200 baud,
8 data bits, no parity, 1 stop bit. Only protocol 3 / `usb-panel-3` unlocks controls.

From this package root:

```sh
python3 usb-panel/serve.py --open
```

On macOS, `Start USB Panel.command` is an alternative. The loopback-only server
normally uses `http://localhost:8765`; it chooses another available port if needed.
Keep its terminal open. Close other serial monitors and duplicate panel tabs.

- Hold Forward/Reverse to jog; release the pointer/key to Stop & Hold.
- Start slow loading advances at a low fixed pulse rate; it does not regulate force.
- Stop & Hold, Escape, Space, the blue board button, limits or the lease timeout stop new step edges.
- Release disables the driver; support the arm first.
- Set reference changes the displayed origin, not the board's boot travel tally.
- Match the physical microstep setting before using estimated degrees; otherwise use pulses.

Defaults: jog 500 pulses/s and 2000 pulses; loading 50 pulses/s and 200 pulses;
15 seconds per operation; boot travel ±2000 pulses. Firmware ceilings: JOG 2000
pulses/s, LOAD 50 pulses/s, run/travel budget 20000 pulses, duration 30 seconds.
Motion stops at the first applicable limit. No reconnect resumes a run.

Record scale reading, baseline and measured perpendicular moment arm while
stopped/holding. Contact moment is `(reading g − baseline g) × 0.00980665 × arm mm / 1000`.
No scale feedback, stall sensor, encoder, current regulation or gravity correction
is supplied. Export CSV before closing the page; trial entries are session-only.

The `dist/` files are dependency-free and require no web build step. Offline tests:
`node --test usb-panel/tests/controller.test.js` from the package root.
