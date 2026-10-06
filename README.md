# Attendance

Attendance web application with a Google Apps Script backend.

Database access keys and spreadsheet IDs are placeholders. Configure matching private values in _index.html and backend/attendance-backend-fixed.txt before deployment. The client endpoint is configured in scripts/attendance.js.

Run checks with:

    node --experimental-vm-modules tests/regression.cjs
    node tests/fixed-backend.cjs
