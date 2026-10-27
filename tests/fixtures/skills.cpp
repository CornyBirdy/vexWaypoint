chassis.setPose(0, 0, 0);
    liftPIDEnabled = 3; // lower lift to home
    pros::delay(100);
    //back toggles spin to colour

    //skills main
    liftTarget = 20;
    liftPIDEnabled = 2;
    chassis.moveToPose(24, 17.25, 90, 4000);
    chassis.waitUntilDone();
    resetAtGoalA();
    liftTarget = 10;
    liftPIDEnabled = 2;
    //lift wait until done
    while (liftPIDEnabled != 1) {
        pros::delay(20);
    }
    clawState = 1; // open claw
    pros::delay(500);
    chassis.moveToPoint(10, 17.25, 4000, {.forwards = false});
    chassis.waitUntilDone();
    clawState = 0; // close claw and spin
    liftPIDEnabled = 3; // lower lift to home
    chassis.turnToHeading(30, 2000);
    chassis.waitUntilDone();
    chassis.moveToPoint(24, 41.25, 4000);
    chassis.waitUntilDone();
    liftTarget = 30;
    liftPIDEnabled = 2;
    chassis.turnToHeading(180, 2000);
    chassis.waitUntilDone();
    chassis.moveToPoint(24, 17.25, 4000);
    chassis.waitUntilDone();
    resetAtGoalA();
    liftTarget = 10;
    liftPIDEnabled = 2;
    //lift wait until done
    while (liftPIDEnabled != 1) {
        pros::delay(20);
    }
    clawState = 1; // open claw
    pros::delay(500);
    chassis.moveToPoint(24, 27.25, 4000, {.forwards = false});
    chassis.waitUntilDone();
    chassis.turnToHeading(120, 2000);
    chassis.waitUntilDone();
    chassis.moveToPoint(48, 17.25, 4000);
    chassis.waitUntilDone();
    chassis.turnToHeading(270, 2000);
    chassis.waitUntilDone();
    chassis.moveToPoint(24, 17.25, 4000);
    chassis.waitUntilDone();
    resetAtGoalA();
    liftTarget = 10;
    liftPIDEnabled = 2;
    //lift wait until done
    while (liftPIDEnabled != 1) {
        pros::delay(20);
    }
    clawState = 1; // open claw
    pros::delay(500);
    chassis.moveToPoint(60, 17.25, 4000, {.forwards = false});
    chassis.waitUntilDone();
    chassis.turnToHeading(180, 2000);
    chassis.waitUntilDone();
    //repeat the following 2 times
    for (int closealliance = 0; closealliance < 2; closealliance++) {
        chassis.moveToPoint(60, 1, 4000);
        chassis.waitUntilDone();
        pros::delay(500);
        chassis.moveToPoint(60, 17.25, 4000, {.forwards = false, .minSpeed = 127, .earlyExitRange = 5});
        pros::delay(500);
        liftTarget = 40 + (closealliance * 10);
        liftPIDEnabled = 2;
        chassis.waitUntilDone();
        chassis.turnToHeading(270, 2000, {.minSpeed = 127, .earlyExitRange = 20});
        chassis.waitUntilDone();
        chassis.moveToPose(60, 17.25, 270, 4000);
        chassis.waitUntilDone();
        resetAtGoalA();
        liftTarget = 10;
        liftPIDEnabled = 2;
        //lift wait until done
        while (liftPIDEnabled != 1) {
            pros::delay(20);
        }
        clawState = 1; // open claw
        pros::delay(500);
        chassis.moveToPoint(60, 17.25, 4000, {.forwards = false});
        chassis.waitUntilDone();
        chassis.turnToHeading(180, 2000);
        chassis.waitUntilDone();
    }
    //repeat the following 3 times
    for (int faralliance = 0; faralliance < 3; faralliance++) {
        chassis.moveToPoint(60, 1, 4000);
        chassis.waitUntilDone();
        pros::delay(500);
        chassis.moveToPoint(60, 17.25, 4000, {.forwards = false, .minSpeed = 127, .earlyExitRange = 5});
        liftTarget = 20 + (faralliance * 10);
        liftPIDEnabled = 2;
        chassis.waitUntilDone();
        chassis.turnToHeading(330, 2000, {.minSpeed = 127, .earlyExitRange = 20});
        chassis.waitUntilDone();
        chassis.moveToPose(48, 41.25, 330, 4000);
        chassis.waitUntilDone();
        resetAtGoalB();
        liftTarget = 10;
        liftPIDEnabled = 2;
        //lift wait until done
        while (liftPIDEnabled != 1) {
            pros::delay(20);
        }
        clawState = 1; // open claw
        pros::delay(500);
        chassis.moveToPoint(60, 17.25, 4000, {.forwards = false});
        chassis.waitUntilDone();
        chassis.turnToHeading(180, 2000);
        chassis.waitUntilDone();
    }
    chassis.moveToPoint(60, 1, 4000);
    chassis.waitUntilDone();
    pros::delay(500);
    chassis.moveToPoint(60, 65.25, 4000, {.forwards = false});
    chassis.turnToHeading(270, 2000);
    chassis.waitUntilDone();
    chassis.moveToPoint(64.75, 65.25, 4000, {.forwards = false});
    chassis.waitUntilDone();
    //toggle
    chassis.moveToPoint(24, 53.25, 4000, {.minSpeed = 127, .earlyExitRange = 5});
    pros::delay(500);
    liftTarget = 30;
    liftPIDEnabled = 2;
    chassis.waitUntilDone();
    chassis.moveToPoint(24, 65.25, 4000);
    chassis.waitUntilDone();
    liftTarget = 20;
    liftPIDEnabled = 2;
    clawState = 1; // open claw
