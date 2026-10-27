#include "main.h"
#include "lemlib/api.hpp" // IWYU pragma: keep

#define SCORE_DELAY 400

enum class Side { LEFT_SIDE, RIGHT_SIDE };
const Side SIDE = Side::RIGHT_SIDE;
bool useClamp = true;

// controller
pros::Controller controller(pros::E_CONTROLLER_MASTER);

// motor groups
pros::MotorGroup leftMotors({-5, -6, -7}, pros::MotorGearset::blue);
pros::MotorGroup rightMotors({8, 9, 10}, pros::MotorGearset::blue);
pros::Motor intake(11, pros::MotorGearset::blue);
pros::adi::DigitalOut clamp('A');

// drivetrain settings
lemlib::Drivetrain drivetrain(&leftMotors, &rightMotors, 10.5, lemlib::Omniwheel::NEW_325, 450, 2);
pros::Imu imu(2);
lemlib::OdomSensors sensors(nullptr, nullptr, nullptr, nullptr, &imu);

lemlib::ControllerSettings lateral_controller(10, 0, 3, 3, 1, 100, 3, 500, 20);
lemlib::ControllerSettings angular_controller(2, 0, 10, 3, 1, 100, 3, 500, 0);
lemlib::Chassis chassis(drivetrain, lateral_controller, angular_controller, sensors);

ASSET(skills_txt)
ASSET(example_txt)

void on_center_button() {
    static bool pressed = false;
    pressed = !pressed;
    if (pressed) {
        pros::lcd::set_text(2, "I was pressed!");
    } else {
        pros::lcd::clear_line(2);
    }
}

void initialize() {
    pros::lcd::initialize();
    chassis.calibrate();
    pros::Task screenTask([&]() {
        while (true) {
            pros::lcd::print(0, "X: %f", chassis.getPose().x);
            pros::delay(50);
        }
    });
}

void disabled() {}
void competition_initialize() {}

static void scoreStack(int times, float backDist = 6) {
    for (int i = 0; i < times; i++) {
        intake.move(127);
        pros::delay(SCORE_DELAY);
        chassis.moveToPoint(0, chassis.getPose().y - backDist, 1000, {.forwards = false}, false);
    }
    intake.move(0);
}

void leftSide() {
    chassis.setPose(0, 0, 0);
    chassis.moveToPoint(0, 24, 3000);
    chassis.turnToHeading(90, 1000);
}

void autonomous() {
    std::vector<lemlib::Pose> stops = {{0, 24, 0}};
    if (SIDE == Side::RIGHT_SIDE) {
        chassis.setPose(0, 0, 0);
        clamp.set_value(true);
        chassis.moveToPoint(0, 24, 3000, {.maxSpeed = 90});
        chassis.waitUntilDone();
        scoreStack(2);
        chassis.turnToHeading(90, 1000);
        chassis.follow(example_txt, 15, 4000);
    } else {
        leftSide();
    }
}

void opcontrol() {
    while (true) {
        int leftY = controller.get_analog(pros::E_CONTROLLER_ANALOG_LEFT_Y);
        int rightX = controller.get_analog(pros::E_CONTROLLER_ANALOG_RIGHT_X);
        chassis.arcade(leftY, rightX);
        pros::delay(10);
    }
}
