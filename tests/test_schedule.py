import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ScheduleTests(unittest.TestCase):
    def read(self, relative):
        return (ROOT / relative).read_text(encoding="utf-8")

    def test_full_installer_uses_nine_hourly_daily_triggers(self):
        script = self.read("scripts/install_windows_task.ps1")
        self.assertIn("15..23 | ForEach-Object", script)
        self.assertIn("New-ScheduledTaskTrigger -Daily", script)
        self.assertIn('Unregister-ScheduledTask -TaskName "Rakuten Ranking Daily"', script)
        self.assertNotIn("$dailyTask", script)
        self.assertIn("RepetitionInterval (New-TimeSpan -Minutes 20)", script)

    def test_schedule_only_installer_preserves_realtime_task(self):
        script = self.read("scripts/install_daily_schedule.ps1")
        self.assertIn("15..23 | ForEach-Object", script)
        self.assertIn("Register-ScheduledTask -TaskName \"Rakuten Ranking Daily Probe\"", script)
        self.assertIn('Unregister-ScheduledTask -TaskName "Rakuten Ranking Daily"', script)
        self.assertNotIn("Read-Host", script)
        self.assertNotIn("Rakuten Ranking Realtime", script)

    def test_old_temporary_installer_delegates_to_permanent_schedule(self):
        script = self.read("scripts/install_today_hourly_probe.ps1")
        self.assertIn("install_daily_schedule.ps1", script)
        self.assertNotIn("New-ScheduledTaskTrigger", script)


if __name__ == "__main__":
    unittest.main()
