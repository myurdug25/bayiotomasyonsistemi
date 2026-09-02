using System.Diagnostics;
using System.Reflection;
using System.Runtime.Versioning;
using System.Text;
using System.Windows.Forms;

namespace PowerSA.B2B.Setup;

[SupportedOSPlatform("windows")]
internal static class Program
{
    private const string AppName = "PowerSA B2B";
    private const string AppUrl = "https://bayiotomasyonsistemi.com/login?v=20260605-login-fast&next=%2Fdashboard&desktop=1";

    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var silent = args.Any((argument) => argument.Equals("/silent", StringComparison.OrdinalIgnoreCase));
        var logPath = Path.Combine(Path.GetTempPath(), "PowerSA-B2B-Setup.log");

        try
        {
            var appDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                AppName);
            Directory.CreateDirectory(appDirectory);

            var iconPath = Path.Combine(appDirectory, "PowerSA.ico");
            WriteEmbeddedIcon(iconPath);

            var browser = FindBrowser();
            var desktopShortcut = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                $"{AppName}.lnk");
            var startMenuDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
                "Programs",
                AppName);
            Directory.CreateDirectory(startMenuDirectory);
            var startMenuShortcut = Path.Combine(startMenuDirectory, $"{AppName}.lnk");

            CreateShortcut(desktopShortcut, browser.targetPath, browser.arguments, iconPath);
            CreateShortcut(startMenuShortcut, browser.targetPath, browser.arguments, iconPath);
            OpenPowerSa(browser.targetPath, browser.arguments);

            if (silent)
            {
                File.WriteAllText(logPath, $"OK{Environment.NewLine}{desktopShortcut}{Environment.NewLine}{startMenuShortcut}{Environment.NewLine}{iconPath}");
            }

            if (!silent)
            {
                MessageBox.Show(
                    "PowerSA B2B masaüstü ve Başlat menüsü kısayolları oluşturuldu.",
                    "PowerSA B2B Kurulum",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
        }
        catch (Exception exception)
        {
            if (silent)
            {
                File.WriteAllText(logPath, exception.ToString());
                Environment.ExitCode = 1;
                return;
            }

            MessageBox.Show(
                $"Kurulum tamamlanamadı.\n\n{exception.Message}",
                "PowerSA B2B Kurulum",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private static void WriteEmbeddedIcon(string iconPath)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("PowerSA.ico")
            ?? throw new InvalidOperationException("PowerSA ikonu kurulum dosyasında bulunamadı.");
        using var file = File.Create(iconPath);
        stream.CopyTo(file);
    }

    private static (string targetPath, string arguments) FindBrowser()
    {
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"),
        };

        var browserPath = candidates.FirstOrDefault(File.Exists);
        if (browserPath is not null)
        {
            return (browserPath, $"--app=\"{AppUrl}\"");
        }

        var explorerPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
        return (explorerPath, AppUrl);
    }

    private static void OpenPowerSa(string targetPath, string arguments)
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = targetPath,
            Arguments = arguments,
            UseShellExecute = false,
        });
    }

    private static void CreateShortcut(string shortcutPath, string targetPath, string arguments, string iconPath)
    {
        try
        {
            var shellType = Type.GetTypeFromProgID("WScript.Shell")
                ?? throw new InvalidOperationException("WScript.Shell bulunamadı.");
            dynamic shell = Activator.CreateInstance(shellType)
                ?? throw new InvalidOperationException("WScript.Shell başlatılamadı.");
            dynamic shortcut = shell.CreateShortcut(shortcutPath);
            shortcut.TargetPath = targetPath;
            shortcut.Arguments = arguments;
            shortcut.WorkingDirectory = Path.GetDirectoryName(targetPath) ?? Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            shortcut.IconLocation = iconPath;
            shortcut.Description = "PowerSA B2B canlı giriş ekranı";
            shortcut.Save();
        }
        catch
        {
            CreateInternetShortcut(Path.ChangeExtension(shortcutPath, ".url"), iconPath);
        }
    }

    private static void CreateInternetShortcut(string shortcutPath, string iconPath)
    {
        var content = new StringBuilder()
            .AppendLine("[InternetShortcut]")
            .AppendLine($"URL={AppUrl}")
            .AppendLine($"IconFile={iconPath}")
            .AppendLine("IconIndex=0")
            .ToString();

        File.WriteAllText(shortcutPath, content, Encoding.UTF8);
    }
}
