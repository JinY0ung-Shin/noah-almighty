using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

int exit = 0;
foreach (var path in args)
{
    try
    {
        using var doc = PresentationDocument.Open(path, false);
        var v = new OpenXmlValidator(FileFormatVersions.Microsoft365);
        var errs = v.Validate(doc).ToList();
        Console.WriteLine($"FILE {path}: {errs.Count} error(s)");
        foreach (var e in errs.Take(50))
        {
            Console.WriteLine($"  [{e.ErrorType}] {e.Part?.Uri} {e.Path?.XPath} :: {e.Description}");
        }
        if (errs.Count > 0) exit = 1;
    }
    catch (Exception ex)
    {
        Console.WriteLine($"FILE {path}: OPEN FAILED {ex.GetType().Name}: {ex.Message}");
        exit = 2;
    }
}
return exit;
