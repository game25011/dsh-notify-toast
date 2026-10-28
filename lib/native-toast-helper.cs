using System;
using System.Globalization;
using System.Net;
using System.Threading;
using Windows.Data.Xml.Dom;
using Windows.Foundation;
using Windows.UI.Notifications;

public static class DshNativeToast
{
    private const int ProgressTickMs = 100;
    private const int RetentionGraceMs = 5000;
    private const int RetractionGraceMs = 300;
    private const int ActivationGraceMs = 750;

    public static void Run(
        string aumid,
        string tag,
        string group,
        string title,
        string body,
        string progressLabel,
        string sessionId,
        string notificationId,
        string callbackUrl,
        string token,
        int durationMs)
    {
        var xml = BuildXml(title, body, progressLabel);
        var document = new XmlDocument();
        document.LoadXml(xml);
        var toast = new ToastNotification(document);
        toast.Tag = tag;
        toast.Group = group;

        var data = new NotificationData();
        data.SequenceNumber = 1;
        data.Values["progressValue"] = "1";
        // Bind the initial data before Show so the first frame has the bound
        // progress value instead of waiting for the first Update().
        toast.Data = data;
        var safeDuration = Math.Max(1000, durationMs);
        // Expiration is a notification-center retention deadline, not a
        // promise about the banner animation. Keep it a little beyond the
        // progress window so the shell can finish its own transition.
        toast.ExpirationTime = DateTimeOffset.Now.AddMilliseconds(safeDuration + RetentionGraceMs);

        var stop = new ManualResetEventSlim(false);
        var activationStarted = new ManualResetEventSlim(false);
        var activationFinished = new ManualResetEventSlim(false);

        if (!string.IsNullOrEmpty(callbackUrl))
        {
            var handler = new TypedEventHandler<ToastNotification, object>(delegate
            {
                activationStarted.Set();
                stop.Set();
                try
                {
                    PostActivation(callbackUrl, token, sessionId, notificationId);
                }
                finally
                {
                    activationFinished.Set();
                }
            });
            AddHandler(toast, "Activated", handler);
        }
        AddHandler(toast, "Dismissed", new TypedEventHandler<ToastNotification, ToastDismissedEventArgs>(delegate
        {
            stop.Set();
        }));
        AddHandler(toast, "Failed", new TypedEventHandler<ToastNotification, ToastFailedEventArgs>(delegate
        {
            stop.Set();
        }));

        var notifier = ToastNotificationManager.CreateToastNotifier(aumid);
        notifier.Show(toast);
        Console.Out.WriteLine("submitted");
        Console.Out.Flush();

        var started = DateTime.UtcNow;
        uint sequence = 2;
        int updateFailures = 0;
        while (!stop.IsSet)
        {
            var elapsed = (int)(DateTime.UtcNow - started).TotalMilliseconds;
            var remaining = Math.Max(0, safeDuration - elapsed);
            if (remaining <= 0) break;
            data.SequenceNumber = sequence++;
            data.Values["progressValue"] = ((double)remaining / safeDuration).ToString("0.###", CultureInfo.InvariantCulture);
            try
            {
                notifier.Update(data, tag, group);
                updateFailures = 0;
            }
            catch
            {
                updateFailures++;
                if (updateFailures >= 3) break;
            }
            if (stop.Wait(ProgressTickMs)) break;
        }

        // ExpirationTime alone does not remove a visible banner on this Windows
        // build (observed: a 3 s toast remained after the 4 s expiration while
        // the helper had already exited). Let the bar finish, then hide the
        // banner after a short grace. Hide() is the only supported way to
        // retract it; do not call it while an activation callback is in flight.
        if (!activationStarted.IsSet)
        {
            Thread.Sleep(RetractionGraceMs);
            try { notifier.Hide(toast); } catch { /* best effort */ }
        }

        // Keep the process alive for notification-center click callbacks until
        // the notification expires. ExpirationTime still bounds retention.
        if (!activationStarted.IsSet)
        {
            var expiration = toast.ExpirationTime;
            var remainingRetentionMs = expiration.HasValue
                ? (expiration.Value - DateTimeOffset.Now).TotalMilliseconds
                : 0;
            if (remainingRetentionMs > 0)
            {
                var waitMs = (int)Math.Min(remainingRetentionMs, durationMs + RetentionGraceMs + 1000.0);
                activationStarted.Wait(TimeSpan.FromMilliseconds(Math.Max(0, waitMs)));
            }
        }
        if (activationStarted.IsSet)
        {
            activationFinished.Wait(ActivationGraceMs);
        }
    }

    private static void AddHandler<TArgs>(ToastNotification toast, string eventName, TypedEventHandler<ToastNotification, TArgs> handler)
    {
        try
        {
            var eventInfo = typeof(ToastNotification).GetEvent(eventName);
            if (eventInfo == null) return;
            eventInfo.GetAddMethod().Invoke(toast, new object[] { handler });
        }
        catch
        {
            // A missing event is not fatal; the process still exits after its
            // bounded grace period.
        }
    }

    private static string BuildXml(string title, string body, string progressLabel)
    {
        var document = new XmlDocument();
        var toast = document.CreateElement("toast");
        toast.SetAttribute("duration", "long");
        var visual = document.CreateElement("visual");
        var binding = document.CreateElement("binding");
        binding.SetAttribute("template", "ToastGeneric");
        var titleNode = document.CreateElement("text");
        titleNode.InnerText = title ?? "";
        binding.AppendChild(titleNode);
        var bodyNode = document.CreateElement("text");
        bodyNode.InnerText = body ?? "";
        binding.AppendChild(bodyNode);
        var progress = document.CreateElement("progress");
        progress.SetAttribute("value", "{progressValue}");
        // Keep the native bar only. Windows needs non-empty title/status on a
        // ToastGeneric progress element; use spaces, and a zero-width override
        // to hide the automatic percentage text.
        progress.SetAttribute("title", " ");
        progress.SetAttribute("status", string.IsNullOrWhiteSpace(progressLabel) ? "Auto close" : progressLabel);
        progress.SetAttribute("valueStringOverride", "​");
        binding.AppendChild(progress);
        visual.AppendChild(binding);
        toast.AppendChild(visual);
        var audio = document.CreateElement("audio");
        audio.SetAttribute("silent", "true");
        toast.AppendChild(audio);
        document.AppendChild(toast);
        return document.GetXml();
    }

    private static void PostActivation(string callbackUrl, string token, string sessionId, string notificationId)
    {
        try
        {
            var payload = "{\"token\":\"" + Escape(token) + "\",\"sessionId\":\"" + Escape(sessionId) + "\",\"notificationId\":\"" + Escape(notificationId) + "\"}";
            using (var client = new WebClient())
            {
                client.Proxy = null;
                client.Headers[HttpRequestHeader.ContentType] = "application/json";
                client.UploadString(callbackUrl, "POST", payload);
            }
        }
        catch
        {
            // Click callback is best-effort; the Host still sees the native toast.
        }
    }

    private static string Escape(string value)
    {
        return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
    }
}
