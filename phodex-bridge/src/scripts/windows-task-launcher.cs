using System;
using System.Diagnostics;
using System.IO;

internal static class WindowsTaskLauncher
{
    private static string QuotePath(string value)
    {
        if (value.IndexOf('"') >= 0) throw new ArgumentException("A path cannot contain quotes.");
        // Double trailing backslashes so they cannot escape the closing quote.
        return "\"" + value + new string('\\', value.Length - value.TrimEnd('\\').Length) + "\"";
    }

    private static int Main(string[] args)
    {
        if (args.Length != 3) return 1;
        try
        {
            Directory.CreateDirectory(Path.Combine(args[1], "logs"));
            var start = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                    @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "
                    + QuotePath(args[0]) + " -Action Run -StateDir " + QuotePath(args[1])
                    + " -TaskName " + QuotePath(args[2]),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using (var process = Process.Start(start))
            {
                process.StandardInput.Close();
                var output = process.StandardOutput.ReadToEndAsync();
                var errors = process.StandardError.ReadToEndAsync();
                process.WaitForExit();
                output.GetAwaiter().GetResult();
                var errorText = errors.GetAwaiter().GetResult();
                if (errorText.Length > 0)
                    File.AppendAllText(Path.Combine(args[1], "logs", "bridge.stderr.log"), errorText);
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            try
            {
                var logs = Path.Combine(args[1], "logs");
                Directory.CreateDirectory(logs);
                File.AppendAllText(Path.Combine(logs, "bridge.stderr.log"), error + Environment.NewLine);
            }
            catch { /* The scheduler still receives the failure if logging is unavailable. */ }
            return 1;
        }
    }
}
