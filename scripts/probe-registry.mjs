fetch("https://registry.npmjs.org/@deepseek-ai%2Fcordis").then(r=>console.log("cordis registry HTTP",r.status)).catch(e=>console.log("fail",e.message))
