$(document).ready(function() {
    startPreview(false);   
});
    
function translateBaseHtmlPage() {
    var mapPreviewText = $.i18n( "mapPreviewText" );
    $( '.mapPreviewText' ).text( mapPreviewText );
}

function writeContent(fileUrl, file, title, authors) {
    addStandardPreviewHeader(file, title, authors);
    
    // set file size limits
    const file_size_limit = 100; // in MB    
    
    //check file size
    const url_to_file_info = fileUrl.replace("access/data","").replace("file","files");   
    
    $.getJSON(url_to_file_info, function( data ) {
        const file_size = data.data.dataFile.filesize/(1024**2);
        
        if (file_size > file_size_limit){
            show_error(`The file is too big to be displayed (limit is ${file_size_limit.toString()} MB)`);
        }else{
            // initialize the map
            var map = L.map('map').fitWorld();
            
            // enable spinner
            var target = document.getElementById('map');
            var spinner = new Spinner().spin(target);
            
            // load a tile layer
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            }).addTo(map);
            
            // get geojson
            $.getJSON(fileUrl, function( geoJsonData ) { 
                // add data to map, including properties if set
                var geoJson = L.geoJSON(geoJsonData, {
                    onEachFeature: function (feature, layer) {
                        if (feature.properties) {
                            var popupcontent = [];
                            for (var propName in feature.properties) {
                                propValue = feature.properties[propName];
                                popupcontent.push("<strong>" + propName + "</strong>: " + JSON.stringify(propValue, null, 2));
                            }
                            layer.bindPopup(popupcontent.join("<br />"));
                        }
                    }
                }).addTo(map);
                
                // zoom to added features
                map.fitBounds(geoJson.getBounds());    
                
                // disable spinner
                spinner.stop();                
            })      
        }
    })
}

function show_error(error_text){
	$('#map').hide();
	$('#file_error').show();
	$('#file_error').append(error_text);
}     
