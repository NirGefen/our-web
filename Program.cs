using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.FileProviders;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Processing;
using SixLabors.ImageSharp.Formats.Jpeg;
using WebPush;
using System.Text.Json;
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);

var storageDir = builder.Configuration["StorageDir"] ?? builder.Environment.ContentRootPath;
Directory.CreateDirectory(storageDir);

var dbPath = Path.Combine(storageDir, "coupleapp.db");
builder.Services.AddDbContext<AppDbContext>(opt =>
    opt.UseSqlite($"Data Source={dbPath}"));

builder.Services.AddCors(opt => opt.AddDefaultPolicy(p =>
    p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.EnsureCreated();
    db.Database.ExecuteSqlRaw(@"
        CREATE TABLE IF NOT EXISTS BucketItems (
            Id INTEGER PRIMARY KEY AUTOINCREMENT,
            Title TEXT NOT NULL,
            Category TEXT NOT NULL,
            AddedBy TEXT NOT NULL,
            IsDone INTEGER NOT NULL DEFAULT 0,
            CreatedAt TEXT NOT NULL
        );");

    db.Database.ExecuteSqlRaw(@"
    CREATE TABLE IF NOT EXISTS PushSubs (
        Id INTEGER PRIMARY KEY AUTOINCREMENT,
        User TEXT NOT NULL,
        Endpoint TEXT NOT NULL,
        P256dh TEXT NOT NULL,
        Auth TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS AppConfigs (
        Key TEXT PRIMARY KEY,
        Value TEXT NOT NULL
    );");

    if (!db.AppConfigs.Any(c => c.Key == "VapidPublic"))
    {
        var keys = VapidHelper.GenerateVapidKeys();
        db.AppConfigs.Add(new AppConfig { Key = "VapidPublic", Value = keys.PublicKey });
        db.AppConfigs.Add(new AppConfig { Key = "VapidPrivate", Value = keys.PrivateKey });
        db.SaveChanges();
    }
}

app.UseCors();

app.UseDefaultFiles();
app.UseStaticFiles();

// 1. INDIVIDUAL PIN CODES (Change these to whatever you want!)
var pinUsers = new Dictionary<string, string>
{
    { "280803", "נירי" },
    { "091104", "נונה" }
};

app.Use(async (context, next) =>
{
    var path = context.Request.Path;
    if (path.StartsWithSegments("/api") || path.StartsWithSegments("/uploads"))
    {
        var pinHeader = context.Request.Headers["X-Secret-Pin"].FirstOrDefault();
        var pinQuery = context.Request.Query["pin"].FirstOrDefault();
        var pin = pinHeader ?? pinQuery;

        if (pin is null || !pinUsers.TryGetValue(pin, out var userName))
        {
            context.Response.StatusCode = 401;
            await context.Response.WriteAsync("Unauthorized");
            return;
        }

        // Attach the authenticated user's name to the request
        context.Items["User"] = userName;
    }

    await next();
});

var uploadsDir = Path.Combine(storageDir, "uploads");
Directory.CreateDirectory(uploadsDir);

app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(uploadsDir),
    RequestPath = "/uploads",
    OnPrepareResponse = ctx =>
    {
        ctx.Context.Response.Headers.Append("Cache-Control", "public,max-age=2592000,immutable");
    }
});

// --- API ENDPOINTS ---

// Verify PIN and return which user logged in
app.MapGet("/api/auth/verify", (HttpContext ctx) =>
    Results.Ok(new { user = ctx.Items["User"]?.ToString() }));

// Get recent messages
app.MapGet("/api/messages", async (AppDbContext db) =>
{
    var recent = await db.Messages
        .OrderByDescending(m => m.CreatedAt)
        .Take(100)
        .ToListAsync();

    recent.Reverse();
    return recent;
});

// Send a message (Sender is set automatically from the PIN)
app.MapPost("/api/messages", async (HttpContext ctx, AppDbContext db, Message msg) =>
{
    msg.Sender = ctx.Items["User"]!.ToString()!;
    msg.CreatedAt = DateTime.UtcNow;
    db.Messages.Add(msg);
    await db.SaveChangesAsync();
    await SendPushToPartner(db, msg.Sender, $"💬 הודעה חדשה מ{msg.Sender}", msg.Text);
    return Results.Ok(msg);
});

// Get all Pins
app.MapGet("/api/pins", async (AppDbContext db) =>
    await db.Pins.OrderByDescending(p => p.CreatedAt).ToListAsync());

// Upload a new Pin (PinnedBy is set automatically from the PIN)
app.MapPost("/api/pins", async (HttpContext ctx, HttpRequest req, AppDbContext db) =>
{
    var form = await req.ReadFormAsync();
    var file = form.Files.GetFile("image");
    var caption = form["caption"].ToString();
    var sender = ctx.Items["User"]!.ToString()!;

    if (file is null || file.Length == 0) return Results.BadRequest("No image provided");

    var fileName = $"{Guid.NewGuid()}{Path.GetExtension(file.FileName)}";
    var filePath = Path.Combine(uploadsDir, fileName);

    using (var stream = new FileStream(filePath, FileMode.Create))
    {
        await file.CopyToAsync(stream);
    }

    var pin = new Pin
    {
        ImageUrl = $"/uploads/{fileName}",
        Caption = caption,
        PinnedBy = sender,
        CreatedAt = DateTime.UtcNow
    };

    db.Pins.Add(pin);
    await db.SaveChangesAsync();
    var user = ctx.Items["User"]!.ToString()!;
    await SendPushToPartner(db, user, "תמונה חדשה בלוח!", $"{user} העלה/תה תמונה חדשה: {caption}");
    return Results.Ok(pin);
});

// 3. DELETE PIN (Only allowed if the logged-in user uploaded it)
app.MapDelete("/api/pins/{id:int}", async (int id, HttpContext ctx, AppDbContext db) =>
{
    var currentUser = ctx.Items["User"]!.ToString()!;
    var pin = await db.Pins.FindAsync(id);

    if (pin is null) return Results.NotFound();
    if (pin.PinnedBy != currentUser) return Results.Forbid();

    // Delete the physical image file from uploads
    var fileName = Path.GetFileName(pin.ImageUrl);
    var filePath = Path.Combine(uploadsDir, fileName);
    if (File.Exists(filePath))
    {
        File.Delete(filePath);
    }

    db.Pins.Remove(pin);
    await db.SaveChangesAsync();
    return Results.Ok();
});

// --- BUCKET LIST ENDPOINTS ---

app.MapGet("/api/bucket", async (AppDbContext db) =>
    await db.BucketItems
        .OrderBy(b => b.IsDone)
        .ThenByDescending(b => b.CreatedAt)
        .ToListAsync());

app.MapPost("/api/bucket", async (HttpContext ctx, AppDbContext db, BucketItem item) =>
{
    if (string.IsNullOrWhiteSpace(item.Title)) return Results.BadRequest();
    item.AddedBy = ctx.Items["User"]!.ToString()!;
    item.IsDone = false;
    item.CreatedAt = DateTime.UtcNow;
    db.BucketItems.Add(item);
    await db.SaveChangesAsync();
    return Results.Ok(item);
});

app.MapPut("/api/bucket/{id:int}/toggle", async (int id, AppDbContext db) =>
{
    var item = await db.BucketItems.FindAsync(id);
    if (item is null) return Results.NotFound();
    item.IsDone = !item.IsDone;
    await db.SaveChangesAsync();
    return Results.Ok(item);
});

app.MapDelete("/api/bucket/{id:int}", async (int id, AppDbContext db) =>
{
    var item = await db.BucketItems.FindAsync(id);
    if (item is null) return Results.NotFound();
    db.BucketItems.Remove(item);
    await db.SaveChangesAsync();
    return Results.Ok();
});

foreach (var file in Directory.GetFiles(uploadsDir))
{
    if (new FileInfo(file).Length < 300 * 1024) continue; // דלג על תמונות שכבר מכווצות
    try
    {
        using var img = Image.Load(file);
        img.Mutate(x => x.AutoOrient().Resize(new ResizeOptions { Mode = ResizeMode.Max, Size = new Size(1200, 1200) }));
        img.SaveAsJpeg(file, new JpegEncoder { Quality = 80 });
    }
    catch { }
}

async Task SendPushToPartner(AppDbContext db, string sender, string title, string message)
{
    Console.WriteLine($"[Push] Started push process by {sender}");

    var pub = await db.AppConfigs.FindAsync("VapidPublic");
    var priv = await db.AppConfigs.FindAsync("VapidPrivate");
    if (pub is null || priv is null)
    {
        Console.WriteLine("[Push Error] VAPID keys not found in DB!");
        return;
    }

    var vapidDetails = new VapidDetails("mailto:admin@example.com", pub.Value, priv.Value);
    var client = new WebPushClient();

    var subs = await db.PushSubs.Where(s => s.User != sender).ToListAsync();
    Console.WriteLine($"[Push] Found {subs.Count} subscriptions for partner.");

    // הנה השורה שהייתה חסרה:
    var payload = JsonSerializer.Serialize(new { title, body = message });

    foreach (var s in subs)
    {
        try
        {
            Console.WriteLine($"[Push] Trying to send notification to {s.User}...");
            var pushSub = new PushSubscription(s.Endpoint, s.P256dh, s.Auth);
            await client.SendNotificationAsync(pushSub, payload, vapidDetails);
            Console.WriteLine($"[Push] Successfully sent to {s.User}!");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Push Error] for {s.User}: {ex.Message}");
        }
    }
}

app.MapGet("/api/push/vapid-public-key", async (AppDbContext db) =>
{
    var key = await db.AppConfigs.FindAsync("VapidPublic");
    return Results.Ok(new { publicKey = key!.Value });
});

app.MapPost("/api/push/subscribe", async (HttpContext ctx, AppDbContext db, PushSubDto dto) =>
{
    var user = ctx.Items["User"]!.ToString()!;
    var existing = await db.PushSubs.FirstOrDefaultAsync(s => s.Endpoint == dto.Endpoint);
    if (existing is null)
    {
        db.PushSubs.Add(new PushSub
        {
            User = user,
            Endpoint = dto.Endpoint,
            P256dh = dto.P256dh,
            Auth = dto.Auth
        });
        await db.SaveChangesAsync();
    }
    return Results.Ok();
});

app.Run();

// --- MODELS & DB CONTEXT ---
public class Message
{
    public int Id { get; set; }
    public string Sender { get; set; } = "";
    public string Text { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}

public class Pin
{
    public int Id { get; set; }
    public string ImageUrl { get; set; } = "";
    public string Caption { get; set; } = "";
    public string PinnedBy { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}

public class BucketItem
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public string Category { get; set; } = "🍔 אוכל";
    public string AddedBy { get; set; } = "";
    public bool IsDone { get; set; }
    public DateTime CreatedAt { get; set; }
}

public class PushSub
{
    public int Id { get; set; }
    public string User { get; set; } = "";
    public string Endpoint { get; set; } = "";
    public string P256dh { get; set; } = "";
    public string Auth { get; set; } = "";
}
public record PushSubDto(string Endpoint, string P256dh, string Auth);

public class AppConfig
{
    [Key]
    public string Key { get; set; } = "";
    public string Value { get; set; } = "";
}

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }
    public DbSet<Message> Messages => Set<Message>();
    public DbSet<Pin> Pins => Set<Pin>();
    public DbSet<BucketItem> BucketItems => Set<BucketItem>();
    public DbSet<PushSub> PushSubs => Set<PushSub>();
    public DbSet<AppConfig> AppConfigs => Set<AppConfig>();
}