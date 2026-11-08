// A synthetic auton built the way real teams write them: helper functions that drive the motors or split a
// move in two, a goal-reset header with structs and constexpr values, integer casts and a pros::Task.
// Used by tests/engine.test.js. (Not copied from any team's code.)
pros::MotorGroup leftMotors({-1, -2, -3}, pros::MotorGearset::blue);
pros::MotorGroup rightMotors({4, 5, 6}, pros::MotorGearset::blue);
lemlib::Drivetrain drivetrain(&leftMotors, &rightMotors, 11, lemlib::Omniwheel::NEW_275, 450, 2);

struct Spot { float x; float y; };
struct ResetLog { bool valid = false; float beforeX = 0, beforeY = 0; float afterX = 0, afterY = 0; float theta = 0; };
inline constexpr Spot TARGET = {30.0f, 20.0f};
inline constexpr float STANDOFF = 7.0f;
inline ResetLog lastReset;
int liftMode = 0;
const int FAST = 89;
const int SLOW = 38;

inline void resetAtTarget() {
    pros::delay(150);
    lemlib::Pose before = chassis.getPose();
    float th = before.theta * M_PI / 180.0f;
    float rx = TARGET.x - STANDOFF * std::sin(th);
    float ry = TARGET.y - STANDOFF * std::cos(th);
    chassis.setPose(rx, ry, before.theta);
    lastReset = {true, before.x, before.y, rx, ry, before.theta};
    printf("reset: before (%.2f, %.2f) after (%.2f, %.2f) heading %.1f\n", before.x, before.y, rx, ry, before.theta);
}

void closeLiftLater() {
    pros::Task([]() {
        pros::delay(200);
        liftMode = 3;
    });
}

// first 70% of the way fast, the rest slow
void driveSplit(float x, float y, int timeout = 4000, int fast = FAST, int slow = SLOW) {
    lemlib::Pose start = chassis.getPose();
    float fastPart = std::hypot(x - start.x, y - start.y) * 0.7;
    chassis.moveToPoint(x, y, timeout, {.maxSpeed = (float)fast});
    chassis.waitUntil(fastPart);
    chassis.cancelMotion();
    chassis.moveToPoint(x, y, timeout, {.maxSpeed = (float)slow});
    chassis.waitUntilDone();
}

// back straight up with the motors until odometry says we moved `inches`
void backOff(float inches, int power = 80, int timeout = 400) {
    chassis.cancelAllMotions();
    lemlib::Pose start = chassis.getPose();
    uint32_t startTime = pros::millis();
    leftMotors.move(-power);
    rightMotors.move(-power);
    while (pros::millis() - startTime < (uint32_t)timeout) {
        lemlib::Pose now = chassis.getPose();
        if (std::hypot(now.x - start.x, now.y - start.y) >= inches) break;
        pros::delay(10);
    }
    leftMotors.move(0);
    rightMotors.move(0);
}

void autonomous() {
    chassis.moveToPoint(0, 12, 4000);
    chassis.waitUntilDone();
    chassis.turnToHeading(90, 4000);
    chassis.waitUntilDone();
    driveSplit(30, 20, 2000);
    resetAtTarget();
    backOff(4);
    closeLiftLater();
    chassis.moveToPoint(14, 20, 4000, {.forwards = false});
    chassis.waitUntilDone();
}
