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

var EmailTemplate = require('email-templates').EmailTemplate

var templateDir = path.join(__dirname, 'email_templates', 'doctor')
var doctorEmail = new EmailTemplate(templateDir)
var stepsMap = {};

// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }))
// parse application/json
app.use(bodyParser.json())
app.set('view engine', 'ejs');  

mongoose.connect('mongodb://arie:arie@ds040489.mlab.com:40489/mshealthbot');
var Schema = mongoose.Schema;
var db = mongoose.connection;
var Tokens;
var Scenarios;

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
        name: String,
        code : String
    });
    Scenarios = mongoose.model('Scenarios', scenariosSchema);

    loadScenariosFolder("Hackathon");
});


/**
 * Build a dialog by going over all steps in this dialog and create a waterfall functions with prompts and statements
 */
function buildDialog(dialog) {
    var funcs = [];
    for (var i = 0; i < dialog.steps.length; i++) {
        var waterfallfunction;
        var currentStep = dialog.steps[i];
        if (currentStep.group) {
            waterfallfunction = function (session, results, next) {
                var step = getStepData(session);
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
                var step = getStepData(session);
                updatePreviousStepData(session, step.prev, results);
                session.endDialog({ response: results.response });
            }
        }
        if (currentStep.type == "prompt") {
            waterfallfunction = function (session, results, next) {

                var step = getStepData(session);
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
                    message.setText(session, text);
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
                var step = getStepData(session);
                updatePreviousStepData(session, step.prev, results);
                var text = evaluateExpression(session, step.text);
                session.send(text);
                if (step.hasOwnProperty('onInit')) {
                    evaluateExpression(session, step.onInit, true);
                }
                session.endDialog();
            }
        }
        funcs.push(waterfallfunction);
    }
    return funcs;
}

/**
 * When top level starts, clear all step variables
 */
function clearDialogData(session, dialog) {
    log.debug("clear all variables from dialog " + dialog.name);
    for (var s = 0; s < dialog.steps.length; s++) {
        delete session.message.botConversationData[dialog.steps[s].variable];
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
        session.message.botConversationData[prevStep.variable] = results.response;
    }
}

function getStepData(session) {
    var top = session.sessionState.callstack[session.sessionState.callstack.length-1];
    var steps = stepsMap[top.id];
    var iStep = top.state['BotBuilder.Data.WaterfallStep'];
    return steps[iStep];
}

/**
 * Replace all variable references and evaluate the resolved expression  
 */
function evaluateExpression(session, value, toEval) {
    var result = value;
    if (typeof (value) == 'string') {
        var re = /\$\{(\S+)\}/g;
        if (value.match(re) || toEval) {
            var replacedExpr = value.replace(re, "session.message.botConversationData['$1']");
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
    stepsMap[dialogNode.name] = dialogNode.steps;
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
    bot.add(dialogNode.name, waterfallFuncs);
    for (var s = 0; s < dialogNode.steps.length; s++) {
        if (dialogNode.steps[s].group) {
            buildDialogRecursive(bot, dialogNode.steps[s].group);
        }
    }
}



/**
 * Load all scenarios and attach them to the command dialog
 */
function loadScenarioFile(bot, commandDialog, code) {
    var scenarios = JSON.parse(code);
    for (var s = 0; s < scenarios.length; s++) {
        var dialog = scenarios[s];
        // Fix dialogs relationship 
        fixupDailogRecursive(dialog, true /*root*/);
        // Build dialogs and add them to the bot
        buildDialogRecursive(bot, dialog);
        // Attach them to commands
        log.debug('loading ' + dialog.intent);
        commandDialog.matches(dialog.intent, builder.DialogAction.beginDialog(dialog.name));
    }    
}

function loadScenariosFolder(scenarioName) {
    Scenarios.findOne({name:scenarioName}, function(err, scenarios){
        var bot = new builder.BotConnectorBot({ appId: 'MS Health', appSecret: '70297ee3cea84f46b27ae939551049bd' });
        var commandDialog = new builder.CommandDialog();
        commandDialog.onDefault(function (session) {
            session.send('I can only answer questions about health and triage');
        });
        bot.add('/', commandDialog);    
        var code = base64.decode(scenarios.code);
        loadScenarioFile(bot,commandDialog, code);        
        app.post('/dynabot', bot.verifyBotFramework(), bot.listen());
    })
}


function sendEmail(session) {
    var data = {data:session.message.botConversationData};
    doctorEmail.render(data, function (err, result) {
        log.debug('===>Email is sent with ',result, err);
    })
}



app.get('/', function(req, res) {
	Scenarios.find({}, function(err, scenarios) {
		res.render('pages/index', {scenarios:scenarios});
	});
});

app.get('/editfile', function(req, res) {
    var name = req.query.file;
    Scenarios.findOne({name:name}, function(err, scenarios){
        var decodedData = base64.decode(scenarios.code);
        scenarios.code = decodedData;
        res.render('pages/editfile', {scenarios:scenarios});
    })
});

app.post('/savefile', function(req, res) {
    var name = req.query.file;
    var body = req.body.editor;
    log.debug("Saving...");
    Scenarios.findOne({name:name}, function(err, scenarios){
        var encoded = base64.encode(body);
        scenarios.code = encoded;
        scenarios.save(function(err, documentFoo, isOK) {
            loadScenariosFolder(name);
            res.redirect('/');
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

