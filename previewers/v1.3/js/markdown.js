$(document).ready(function() {
startPreview(true);
});

function writeContentAndData(data, fileUrl, file, title, authors) {
    addStandardPreviewHeader(file,title, authors);
    converter = new showdown.Converter();
    htmlData = converter.makeHtml(data)
    options = {"stripIgnoreTag":true,
           "stripIgnoreTagBody":['script','head']};  // Custom rules

    $('.preview').append($("<div/>").html(filterXSS(htmlData,options)));
}
