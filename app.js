/**
 * Author:Arie Schwartzman (Microsoft)
 * Build BOT dynamically from a JSON file
 */
var builder = require('botbuilder');
var bunyan = require('bunyan');
var log = bunyan.createLogger({ name: 'bot', level: 'debug' });
var express = require('express');
var app = express();
var fs = require('fs');
var walker = require('walker');

app.set('view engine', 'ejs');  

//var scenarios = require('./scenarios.json');

/**
 * Build a dialog by going over all steps in this dialog and create a waterfall functions with prompts and statements
 */
function buildDialog(dialog) {
    var funcs = [];
    for (var i = 0; i < dialog.steps.length; i++) {
        var waterfallfunction;
        var currentStep = dialog.steps[i];
        if (currentStep.dialog) {
            (function (step) {
                waterfallfunction = function (session, results, next) {
                    updatePreviousStepData(session, step.prev, results);
                    if (step.dialog.hasOwnProperty('visible') && !evaluateExpression(session, step.dialog.visible)) {
                        next();
                    }
                    else {
                        session.beginDialog(step.dialog.name);
                    }
                }
            })(currentStep)
        }
        if (currentStep.type == "endDialog") {
            (function (step) {
                waterfallfunction = function (session, results, next) {
                    updatePreviousStepData(session, step.prev, results);
                    session.endDialog({ response: results.response });
                }
            })(currentStep)
        }
        if (currentStep.type == "prompt") {
            (function (step) {
                waterfallfunction = function (session, results, next) {
                    if (step.firstStep) {
                        clearDialogData(session, dialog);
                    }
                    updatePreviousStepData(session, step.prev, results);
                    if (step.prev && step.prev.hasOwnProperty('onPost')) {
                        evaluateExpression(session, step.prev.onPost);
                    }
                    if (step.hasOwnProperty('visible') && !evaluateExpression(session, step.visible)) {
                        next();
                    }
                    else {
                        if (step.hasOwnProperty('onInit')) {
                            evaluateExpression(session, step.init);
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
            })(currentStep)
        }
        if (currentStep.type == "statement") {
            (function (step) {
                waterfallfunction = function (session, results) {
                    updatePreviousStepData(session, step.prev, results);
                    var text = evaluateExpression(session, step.text);
                    session.send(text);
                    session.endDialog();
                }
            })(currentStep)
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
        if (dialog.steps[s].dialog) {
            clearDialogData(session, dialog.steps[s].dialog);
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

/**
 * Replace all variable references and evaluate the resolved expression  
 */
function evaluateExpression(session, value) {
    var result = value;
    if (typeof (value) == 'string') {
        var re = /\$\{(\S+)\}/g;
        if (value.match(re)) {
            var replacedExpr = value.replace(re, "session.message.botConversationData['$1']");
            log.debug(replacedExpr);
            result = eval(replacedExpr);
        }
    }
    return result;
} 

function fixupDailogRecursive(dialogNode, isRoot) {
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
        if (dialogNode.steps[s].dialog) {
            fixupDailogRecursive(dialogNode.steps[s].dialog, false);
        }
    }
}

/**
 * Build a dialog with all the sub dialogs
 */
function buildDialogRecursive(bot, dialogNode) {
    bot.add(dialogNode.name, buildDialog(dialogNode));
    for (var s = 0; s < dialogNode.steps.length; s++) {
        if (dialogNode.steps[s].dialog) {
            buildDialogRecursive(bot, dialogNode.steps[s].dialog);
        }
    }
}



/**
 * Load all scenarios and attach them to the command dialog
 */
function loadScenarioFile(bot, commandDialog, filename) {
    fs.readFile(filename, function(err, data){
        var scenarios = JSON.parse(data);
        if (err) throw err;
        for (var s = 0; s < scenarios.length; s++) {
            var dialog = scenarios[s];
            // Fix dialogs relationship 
            fixupDailogRecursive(dialog, true);
            // Build dialogs and add them to the bot
            buildDialogRecursive(bot, dialog);
            // Attach them to commands
            log.debug('loading ' + dialog.intent);
            commandDialog.matches(dialog.intent, builder.DialogAction.beginDialog(dialog.name));
        }    
    });
}

function loadScenariosFolder(path) {
    var bot = new builder.BotConnectorBot({ appId: 'MS Health', appSecret: '70297ee3cea84f46b27ae939551049bd' });
    var commandDialog = new builder.CommandDialog();
    commandDialog.onDefault(function (session) {
        session.send('I can only answer questions about health and triage');
    });
    bot.add('/', commandDialog);    
    var w = walker(path);
    w.on('file', function(file, stat) {
        log.debug('loading file ' + file);
        loadScenarioFile(bot,commandDialog, file);
    });
    app.post('/dynabot', bot.verifyBotFramework(), bot.listen());
}

loadScenariosFolder('./scenariosLibrary');


app.get('/', function(req, res) {
    var files = [];
    var w = walker('./scenariosLibrary').on('file', function(file, stat){
        files.push(file);
    });
    w.on('end', function(){
        res.render("pages/index", {files:files});
    }) ;
});


/**
 * Setup Express server
 */
app.listen(8081, function () {
  log.debug('DynaBot listening on port 8081!');
});

