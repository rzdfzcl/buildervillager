using System;
using System.IO;
using System.Management.Automation;
using System.Management.Automation.Runspaces;
using System.Threading;
using System.Windows;

public static class BuilderVillagerPanelHost {
    [STAThread]
    public static void Main(string[] args) {
        try {
            string folder = AppDomain.CurrentDomain.BaseDirectory;
            string server = Path.GetFullPath(args.Length > 0 ? args[0] : Path.Combine(folder, ".."));
            using (Runspace runspace = RunspaceFactory.CreateRunspace()) {
                runspace.ApartmentState = ApartmentState.STA;
                runspace.ThreadOptions = PSThreadOptions.UseCurrentThread;
                runspace.Open();
                using (PowerShell shell = PowerShell.Create()) {
                    shell.Runspace = runspace;
                    shell.AddCommand("Set-ExecutionPolicy").AddParameter("Scope", "Process").AddParameter("ExecutionPolicy", "Bypass").AddParameter("Force");
                    shell.Invoke(); shell.Commands.Clear();
                    shell.AddCommand(Path.Combine(folder, "panel.ps1")).AddParameter("ServerDirectory", server);
                    shell.Invoke();
                    if (shell.InvocationStateInfo.Reason != null) throw shell.InvocationStateInfo.Reason;
                }
            }
        } catch (Exception error) {
            MessageBox.Show(error.Message, "BuilderVillager Panel", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
}
