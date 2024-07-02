$(document).ready(function() {
    startPreview(true);
});
    
function translateBaseHtmlPage() {
    var o3dPreviewText = $.i18n( "o3dPreviewText" );
    $( '.o3dPreviewText' ).text( o3dPreviewText );
}

function writeContentAndData(data, fileUrl, file, title, authors) {
    addStandardPreviewHeader(file, title, authors);
    
    /** Human readable formats could also be displayed (as text or xml or json).
    options = {};  // Custom rules
    $('.preview').append($("<pre/>").html(filterXSS(data,options)));
    */
    
    // set the location of the external libraries
    OV.SetExternalLibLocation ('../lib/o3dv/libs');

    // get the parent element of the viewer
    let parentDiv = document.getElementById ('o3d_viewer');

    // initialize the viewer with the parent element and some parameters
    let viewer = new OV.EmbeddedViewer (parentDiv, {
        camera : new OV.Camera (
            new OV.Coord3D (-1.5, 2.0, 3.0),
            new OV.Coord3D (0.0, 0.0, 0.0),
            new OV.Coord3D (0.0, 1.0, 0.0),
            45.0
        ),
        backgroundColor : new OV.RGBAColor (255, 255, 255, 255),
        defaultColor : new OV.RGBColor (200, 200, 200),
        edgeSettings : new OV.EdgeSettings (false, new OV.RGBColor (0, 0, 0), 1),
        /**
        environmentSettings : new OV.EnvironmentSettings (
            [
                'assets/envmaps/fishermans_bastion/posx.jpg',
                'assets/envmaps/fishermans_bastion/negx.jpg',
                'assets/envmaps/fishermans_bastion/posy.jpg',
                'assets/envmaps/fishermans_bastion/negy.jpg',
                'assets/envmaps/fishermans_bastion/posz.jpg',
                'assets/envmaps/fishermans_bastion/negz.jpg'
            ],
            false
        )
        */
    });

    console.log("Start loading file: " + file.filename + " From: " + fileUrl);
   
    // load a model providing model urls
    //viewer.LoadModelFromUrlList ([
    //    fileUrl
    //]);
    
    // It tries tio get a filename from the URL, which won't work here
    //    
    // https://github.com/kovacsv/Online3DViewer/issues/424
    //
    //const dataBlob = await fetch(fileUrl).then(res => res.blob());
    //const dataFile = new File([dataBlob], file);  // must manually provide correct extension
    //viewer.LoadModelFromFileList([dataFile]);

    // TODO fix problem with the filename, only have it in 'Open In New Window' link
    filename = "";
    if (file.hasOwnProperty("filename")) {
        console.log("File has filename: " + file.filename);
        filename = file.filename;
    } else {
        console.log("File has no filename, try extracting it from the page");
        // Note that we are in an iframe, so we need to get the filename from the parent
        filename = window.parent.$(".file-title-label").text();
        console.log("filename: " + filename);
    }
    const dataFile = new File([data], filename);
    viewer.LoadModelFromFileList([dataFile]);

    // TODO, force to view whole object if possible?
    //viewer.FitAll ();
}
