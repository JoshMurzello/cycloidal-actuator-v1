# Protocol 3

## Protocol version 3

Each command ends in newline. Identification:

- `HELLO`: stop an active motion, reply `{"type":"hello","protocol":3,"firmware":"usb-panel-3"}` plus status.
- `STATUS`: request live status (also transmitted approximately every 100 ms).
- `RUN id direction rate pulses milliseconds`: continuous JOG.
- `LOAD id direction rate pulses milliseconds`: continuous LOAD.
- `KEEP id`: renew the matching active motion lease only.
- `STOP id`: stop and hold, even if the ID is stale.
- `RELEASE id`: disable the driver.
- `ZERO id`: set display origin to current pulse tally while idle.
- `LIMIT id pulses`: change absolute travel bound while idle.

IDs are positive integers up to 2147483647. Starts/configuration require an ID above `status.last`; repeated/stale starts cannot restart a stopped motion. Heartbeats do not reset pulse/time budgets. Direction is ±1. Rate is 1–2000 pulses/s for JOG, 1–50 for LOAD, with acceleration from up to 25 pulses/s at 1000 pulses/s². Operation budget is 1–20000 pulses; duration 100–30000 ms. Serial parsing rejects malformed/overflowed input; line errors stop active motion. TX/RX are nonblocking peripheral polls; no IRQ/config changes are required.

Status JSON includes mode, position, origin, limit, target/current rate, remaining pulse budget, active motion ID, last command ID, and reason. GPIO commanded enable is not measured motor current. Confirm the physical meaning of forward/reverse clear of the scale.

