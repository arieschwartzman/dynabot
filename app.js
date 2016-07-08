/**
 * Author:Arie Schwartzman (Microsoft)
 * Build BOT dynamically from a JSON file
 */
var bunyan = require('bunyan');
var log = bunyan.createLogger({ name: 'bot', level: 'debug' });
var express = require('express');
var app = express();
var path = require('path');
var uuid = require('node-uuid');
var mongoose = require('mongoose');
var base64 = require('base-64');
var bodyParser = require('body-parser');
var builder = require('botbuilder');
var removeRoute = require('express-remove-route');  

var EmailTemplate = require('email-templates').EmailTemplate

var templateDir = path.join(__dirname, 'email_templates', 'doctor')
var doctorEmail = new EmailTemplate(templateDir)

// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }))
// parse application/json
app.use(bodyParser.json())
app.set('view engine', 'ejs'); 
app.use(express.static('public'));

mongoose.Promise = require("bluebird");
mongoose.connect('mongodb://arie:arie@ds040489.mlab.com:40489/mshealthbot');
var Schema = mongoose.Schema;
var db = mongoose.connection;
var Tokens;
var Scenarios;
var loadError;

db.on('error', function(err){
    log.error(err);
});

db.once('open', function() {
    // Create your schemas and models here.
	log.info("db opened");
	var tokenSchema = new Schema({
		name: String,
        msh_token: String
	});	
	Tokens = mongoose.model('Tokens', tokenSchema);

    var scenariosSchema = new Schema({
        active      :Boolean,
        name        :String,
        description :String,
        code        :String
    });
    Scenarios = mongoose.model('Scenarios', scenariosSchema);

    try {
        loadScenariosFolder(function(){
            
        });
    }
    catch(e) {
        loadError = e.message;
        log.error("Failed to load scenarios %s", e);
    }
});


/**
 * Build a dialog by going over all steps in this dialog and create a waterfall functions with prompts and statements
 */
function buildDialog(dialog) {
    var waterfallFunctions = [];
    for (var i = 0; i < dialog.steps.length; i++) {
        var waterfallfunction;
        var currentStep = dialog.steps[i];
        (function(step){
            if (step.group) {
                waterfallfunction = function (session, results, next) {
                    updatePreviousStepData(session, step.prev, results);
                    if (step.group.hasOwnProperty('visible') && !evaluateExpression(session, step.group.visible)) {
                        next();
                    }
                    else {
                        session.beginDialog(step.group.name);
                    }
                }
            }
            if (currentStep.type == "endDialog") {
                waterfallfunction = function (session, results, next) {
                    updatePreviousStepData(session, step.prev, results);
                    session.endDialog({ response: results.response });
                }
            }
            if (currentStep.type == "prompt") {
                waterfallfunction = function (session, results, next) {
                    if (step.firstStep) {
                        clearDialogData(session, dialog);
                    }
                    updatePreviousStepData(session, step.prev, results);
                    if (step.prev && step.prev.hasOwnProperty('onPost')) {
                        evaluateExpression(session, step.prev.onPost, true);
                    }
                    if (step.hasOwnProperty('visible') && !evaluateExpression(session, step.visible, true)) {
                        next();
                    }
                    else {
                        if (step.hasOwnProperty('onInit')) {
                            eval(step.onInit)
                            evaluateExpression(session, step.init, true);
                        }
                        var text = evaluateExpression(session, step.text);
                        var message = new builder.Message();
                        message.text(text);
                        // If there is an image, attach it
                        if (step.hasOwnProperty('image')) {
                            message.addAttachment({
                                contentType: 'image/png',
                                contentUrl: evaluateExpression(session, step.image)
                            });
                        }
                        if (Array.isArray(step.dataType)) {
                            builder.Prompts.choice(session, message, step.dataType);
                        } else if (step.dataType == 'boolean') {
                            builder.Prompts.confirm(session, message);
                        } else if (step.dataType == 'number') {
                            builder.Prompts.number(session, message);
                        } else if (step.dataType == 'time') {
                            builder.Prompts.time(session, message)
                        }
                        else {
                            builder.Prompts.text(session, message);
                        }
                    }
                }
            }
            if (currentStep.type == "statement") {
                waterfallfunction = function (session, results) {
                    updatePreviousStepData(session, step.prev, results);
                    var text = evaluateExpression(session, step.text);
                    session.send(text);
                    if (step.hasOwnProperty('onInit')) {
                        evaluateExpression(session, step.onInit, true);
                    }
                    session.endDialog();
                }
            }
        })(currentStep);

        waterfallFunctions.push(waterfallfunction);
    }
    return waterfallFunctions;
}

/**
 * When top level starts, clear all step variables
 */
function clearDialogData(session, dialog) {
    log.debug("clear all variables from dialog " + dialog.name);
    for (var s = 0; s < dialog.steps.length; s++) {
        //delete session.message.botConversationData[dialog.steps[s].variable];
        session.userData[dialog.steps[s].variable] = undefined;
        if (dialog.steps[s].group) {
            clearDialogData(session, dialog.steps[s].group);
        }
    }
}

/**
 * Set step variable with a new value 
 */
function updatePreviousStepData(session, prevStep, results) {
    if (prevStep && prevStep.variable && results) {
        log.debug("udating step % with data=%", prevStep, results.response);
        session.userData[prevStep.variable] = results.response; 
        //session.message.botConversationData[prevStep.variable] = results.response;
    }
}

/**
 * Replace all variable references and evaluate the resolved expression  
 */
function evaluateExpression(session, value, toEval) {
    var result = value;
    if (typeof (value) == 'string') {
        var re = /\$\{(\S+)\}/g;
        if (value.match(re) || toEval) {
            var replacedExpr = value.replace(re, "session.userData['$1']");
            log.debug(replacedExpr);
            result = eval(replacedExpr);
        }
    }
    return result;
} 

function fixupDailogRecursive(dialogNode, isRoot) {
    if (!isRoot){
        dialogNode.name = uuid.v4(); 
    } 
    for (var s = 0; s < dialogNode.steps.length; s++) {
        if (!isRoot &&  dialogNode.steps[dialogNode.steps.length-1].type != 'endDialog') {
            dialogNode.steps.push({type:'endDialog'});
        }
        if (s > 0) {
            dialogNode.steps[s].prev = dialogNode.steps[s - 1];
        }
        if (isRoot && s == 0) {
            dialogNode.steps[0].firstStep = true;
        }
        if (dialogNode.steps[s].group) {
            fixupDailogRecursive(dialogNode.steps[s].group, false);
        }
    }
}

/**
 * Build a dialog with all the sub dialogs
 */
function buildDialogRecursive(bot, dialogNode) {
    var waterfallFuncs =  buildDialog(dialogNode);
    bot.dialog(dialogNode.name, waterfallFuncs);
    for (var s = 0; s < dialogNode.steps.length; s++) {
        if (dialogNode.steps[s].group) {
            buildDialogRecursive(bot, dialogNode.steps[s].group);
        }
    }
}



/**
 * Load all scenarios and attach them to the command dialog
 */
function loadScenarioFile(bot, intents, scenarios) {
    for (var s = 0; s < scenarios.length; s++) {
        var dialog = scenarios[s];
        // Fix dialogs relationship 
        fixupDailogRecursive(dialog, true /*root*/);
        // Build dialogs and add them to the bot
        buildDialogRecursive(bot, dialog);
        // Attach them to commands
        log.debug('loading ' + dialog.intent);
        intents.matches(new RegExp(dialog.intent), [
            function(session) {
                session.beginDialog(dialog.name)
            }
        ]);
    }    
}


function loadScenariosFolder(callback) {   
    loadError = undefined;
    var query = Scenarios.find({});
    query.then(function(scenarios) {
        var scenariosArray = [];
        for (s=0; s < scenarios.length; s++) {
            var scenario = scenarios[s];
            if (scenario.active) {
                var jsonCode = base64.decode(scenario.code);
                if (jsonCode.length > 0) {
                    try {
                        var code = JSON.parse(jsonCode);
                        scenariosArray.push(code);
                    }
                    catch(e) {
                        log.error("Failed to parse %s", e.message);
                    }
                }
            }
        }
        if (scenariosArray.length > 0) {
            var connector = new builder.ChatConnector({
                appId: undefined,
                appPassword: undefined
            });
            //var connector = new builder.ConsoleConnector().listen();
            var bot = new builder.UniversalBot(connector);
            var intents = new builder.IntentDialog();
            intents.onDefault([
                function (session, results) {
                    session.send('I can only answer health questions');
                }
            ]);

            bot.dialog('/', intents);
            try {
                loadScenarioFile(bot, intents, scenariosArray);
            }
            catch (e) {
                log.error("Failed to load scenarion %s", e.message);
                loadError = e.message;
            }                        
            app.post('/dynabot', connector.listen());
            callback();
        }
    });
}


function sendEmail(session) {
    var data = {data:session.message.userData};
    doctorEmail.render(data, function (err, result) {
        log.debug('===>Email is sent with ',result, err);
    })
}


function reloadApp(callback) {
    removeRoute(app, '/dynabot');
    loadScenariosFolder(callback);
}



app.get('/', function(req, res) {
	Scenarios.find({}, function(err, scenarios) {
        var data = {
            error:loadError,
            scenarios:scenarios
        }        
		res.render('pages/index', data);
	});
});

app.get('/editfile', function(req, res) {
    var name = req.query.file;
    var mode = req.query.mode;
    Scenarios.findOne({name:name}, function(err, scenario){
        var decodedData = base64.decode(scenario.code);
        scenario.code = decodedData;
        scenario.mode = mode;
        res.render('pages/editfile', {scenario:scenario});
    })
});

app.get('/activate', function(req, res) {
    var id = req.query.name;
    var active = req.query.value;

    Scenarios.findOne({_id:id}, function(err, scenario) {
        scenario.active = (active == 'true') ? true : false;
        scenario.save(function(err1, documentFoo, isOK){
            if (isOK) {
                reloadApp(function(){
                    res.redirect(active=='true' ? '/?message=Scenario Enabled':'/?message=Scenario Disabled');
                });
            }            
        });

    });
});

app.get('/delete', function(req, res, next){
    var name = req.query.file;
    Scenarios.remove({name:name}, function(err, scenario){
        reloadApp(function(){
            res.redirect('/');        
        });
    });
});

app.get('/addfile', function(req, res) {
    var scenario = {name:'', code:'{\n\t"name":"",\n\t"intent":"",\n\t"steps":[\n\t\t{\n\t\t}\n\t]\n}', newDoc : true};
    res.render('pages/editfile', {scenario:scenario});    
})

app.post('/savefile', function(req, res, next) {
    var name = req.query.file;
    var body = req.body.editor;

    try {
        var code = JSON.parse(body);
    }
    catch(e) {
        return next(e);
    }
    
    log.debug("Saving...");
    Scenarios.findOne({name:name}, function(err, scenario){
        if (scenario == null) {
            scenario = new Scenarios();
            scenario.name = req.body.name;
            scenario.description = req.body.description;
        }
        var encoded = base64.encode(body);
        scenario.code = encoded;
        scenario.save(function(err, documentFoo, isOK) {
            // Remove previous bot
            reloadApp(function(){
                res.redirect('/?message=' + scenario.name + ' Saved');

            });
        });
        // Reload the scenarios file
    });
})

/**
 * Setup Express server
 */
app.listen(8081, function () {
  log.debug('DynaBot listening on port 8081!');
});

