# Wiring — active CubeIDE controller

Controller: STM32 NUCLEO-L476RG. Driver: EASON TB6600. Motor: STEPPERONLINE NEMA 23,
2.4 N·m rated **holding** torque, 4 A per phase, 8 mm shaft. Manufacturer model
match is 23HS32-4004S; that match is not a photograph of the physical motor label.
The reduction in this build is 15:1.

## Signal wiring: common cathode

| Function | Nucleo pin | Driver connection |
| --- | --- | --- |
| Step | PB4 / Arduino D5 | PUL+ |
| Direction | PB5 / Arduino D4 | DIR+ |
| Enable/offline | PB6 / Arduino D10 | ENA+ (sometimes labelled EN+) |
| Signal return | GND | PUL−, DIR− and ENA− |
| Serial transport | ST-LINK USB virtual COM | USART2, PA2/PA3 internally routed through ST-LINK |
| Stop button | PC13 | On-board blue user button |
| Status | PA5 | On-board LD2 |

The supplied firmware sets PB4/PB5/PB6 to push-pull outputs. ENA low commands
energized hold; ENA high releases/freewheels on the documented bench driver.
This is a commanded state, not a measurement of actual motor current.

Do not substitute the old PA8/D7 and PA9/D8 common-anode diagram from earlier
project history. It belongs to another firmware version.

## Motor power and settings

Connect the two motor coils to A+/A− and B+/B− after identifying each coil pair.
Use the actual driver label/manual for its power input and current switches. The
motor's 4 A rating does not prove the selected driver setting. Supply voltage,
driver current and physical microstep switches used for the filmed preliminary
test were not preserved as confirmed settings, so no switch photograph is inferred.

The panel's degree conversion assumes 200 full steps per motor turn and 15:1
reduction. Choose the actual DIP microstep setting; until then use pulse counts.
At 4× microstepping, one commanded pulse represents 0.03 output degrees.

Programming/reset can release the motor. Support the arm and begin with the
mechanism unloaded. This bench fixture is not a safety-rated brake.
