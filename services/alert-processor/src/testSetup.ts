// Tests exercise failure paths on purpose, and those paths log at error level. Silence the
// logger so a passing run is readable; set LOG_LEVEL when debugging a test.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
