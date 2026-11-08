#include "main.h"

// Path exported from path.jerryio. Drop example.txt onto the sim and this
// name (file name with the dot turned into _) becomes available.
ASSET(example_txt)

void autonomous() {
    // Field coordinates, like on a real robot: the origin is the middle of the field and 0 deg faces
    // up the field. This puts the robot at the bottom-left start of the sim; the sim starts it here.
    chassis.setPose(-58, -58, 0);

    chassis.moveToPoint(-58, -36, 3000);            // drive forward 22 in
    chassis.turnToHeading(90, 1500);                // face right
    chassis.moveToPose(-36, -36, 90, 3000, {.lead = 0.5});
    chassis.waitUntilDone();

    // follow a jerry.io path: lookahead 15 in, 4 s timeout
    chassis.follow(example_txt, 15, 4000);
    chassis.waitUntilDone();

    chassis.turnToPoint(0, 0, 1000);                // look at the centre goal
    chassis.swingToHeading(180, lemlib::DriveSide::LEFT, 1500);
    chassis.moveToPoint(-36, -12, 3000, {.forwards = false, .maxSpeed = 80});
    chassis.waitUntilDone();
}
